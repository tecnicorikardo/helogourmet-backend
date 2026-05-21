// ============================================================
// BACKEND — Pix via Efí Bank + Webhook
// ============================================================
const express = require('express');
const cors = require('cors');
const https = require('https');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Firebase Admin
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  console.log('Firebase Admin conectado.');
} catch (e) {
  console.warn('Firebase Admin não configurado:', e.message);
}

// ── Efí Bank config
const EFI_CLIENT_ID     = process.env.EFI_CLIENT_ID     || '';
const EFI_CLIENT_SECRET = process.env.EFI_CLIENT_SECRET || '';
const EFI_SANDBOX       = process.env.EFI_SANDBOX === 'true';
const EFI_BASE_HOST     = EFI_SANDBOX ? 'pix-h.api.efipay.com.br' : 'pix.api.efipay.com.br';

console.log(`Efí Bank: ${EFI_SANDBOX ? 'SANDBOX' : 'PRODUCAO'} | ${EFI_BASE_HOST}`);
console.log(`Client ID: ${EFI_CLIENT_ID ? EFI_CLIENT_ID.slice(0,15) + '...' : 'NAO CONFIGURADO'}`);

// ── Certificado mTLS (base64 → buffer)
let efiCert = null;
if (process.env.EFI_CERT_BASE64) {
  efiCert = Buffer.from(process.env.EFI_CERT_BASE64, 'base64');
  console.log(`Certificado: ${efiCert.length} bytes`);
} else {
  console.warn('EFI_CERT_BASE64 nao configurado');
}

// ── Agent HTTPS com certificado
function makeAgent() {
  const opts = { rejectUnauthorized: false };
  if (efiCert) { opts.pfx = efiCert; opts.passphrase = ''; }
  return new https.Agent(opts);
}

// ── Requisição genérica para Efí Bank
function efiReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const opts = { hostname: EFI_BASE_HOST, path, method, headers, agent: makeAgent() };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Obtém token OAuth
async function getToken() {
  const creds = Buffer.from(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`).toString('base64');
  const body = JSON.stringify({ grant_type: 'client_credentials' });
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    const opts = { hostname: EFI_BASE_HOST, path: '/oauth/token', method: 'POST', headers, agent: makeAgent() };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error(json.error_description || JSON.stringify(json)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Rota de saúde
app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Helo Gourmet Backend', gateway: 'Efi Bank' }));

// ── Gerar QR Code Pix
app.post('/criar-pix', async (req, res) => {
  try {
    const { itens, total } = req.body;
    if (!itens || itens.length === 0) return res.status(400).json({ erro: 'Carrinho vazio.' });

    let pedidoId = 'sem-id';
    if (db) {
      const ref = await db.collection('pedidos').add({
        itens, total, status: 'pendente', tipoPagamento: 'pix', criadoEm: Timestamp.now()
      });
      pedidoId = ref.id;
    }

    const descricao = itens.map(i => `${i.quantidade}x ${i.nome}`).join(', ');
    const token = await getToken();

    // Cria cobrança
    const cobBody = {
      calendario: { expiracao: 3600 },
      valor: { original: Number(total).toFixed(2) },
      chave: process.env.EFI_PIX_KEY || '',
      solicitacaoPagador: descricao.slice(0, 140),
      infoAdicionais: [{ nome: 'Pedido', valor: pedidoId }]
    };
    const cob = await efiReq('POST', '/v2/cob', token, cobBody);
    if (cob.status !== 201) throw new Error(cob.body?.mensagem || JSON.stringify(cob.body));

    const txid = cob.body.txid;
    const locId = cob.body.loc?.id;

    // Gera QR Code
    let qrCode = '', qrCodeBase64 = '';
    if (locId) {
      const qr = await efiReq('GET', `/v2/loc/${locId}/qrcode`, token);
      qrCode = qr.body.qrcode || '';
      qrCodeBase64 = (qr.body.imagemQrcode || '').replace('data:image/png;base64,', '');
    }

    if (db && pedidoId !== 'sem-id') {
      await db.collection('pedidos').doc(pedidoId).update({ txid, locId });
    }

    res.json({ pedidoId, txid, qrCode, qrCodeBase64, status: cob.body.status });

  } catch (err) {
    console.error('Erro Pix:', err?.message || err);
    res.status(500).json({ erro: `Erro ao gerar Pix: ${err?.message || 'Erro desconhecido'}` });
  }
});

// ── Verificar status
app.get('/status-pix/:txid', async (req, res) => {
  try {
    const token = await getToken();
    const r = await efiReq('GET', `/v2/cob/${req.params.txid}`, token);
    res.json({ status: r.body.status === 'CONCLUIDA' ? 'approved' : 'pending', statusEfi: r.body.status });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao verificar status.' });
  }
});

// ── Webhook Efí (GET para validação)
app.get('/webhook', (req, res) => res.sendStatus(200));

// ── Webhook Efí (POST — pagamento confirmado)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const pixes = req.body?.pix || [];
    for (const pix of pixes) {
      if (!pix.txid || !db) continue;
      const snap = await db.collection('pedidos').where('txid', '==', pix.txid).limit(1).get();
      if (snap.empty) continue;
      await snap.docs[0].ref.update({
        status: 'pago',
        pagamentoId: pix.endToEndId || pix.txid,
        atualizadoEm: Timestamp.now()
      });
      console.log(`Pix pago: ${pix.txid}`);
    }
  } catch (err) {
    console.error('Erro webhook:', err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
