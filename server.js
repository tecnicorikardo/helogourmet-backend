// ============================================================
// BACKEND — Webhook Mercado Pago + Criar Preferência de Pagamento
// Deploy no Render.com (free tier, sem cartão)
// ============================================================
const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const app = express();
app.use(cors({ origin: '*' })); // Restrinja ao domínio do seu site em produção
app.use(express.json());

// ── Mercado Pago — coloque seu Access Token aqui ou em variável de ambiente
const mp = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || 'SEU_ACCESS_TOKEN_AQUI'
});

// ── Firebase Admin — use variável de ambiente com o JSON da service account
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  console.log('Firebase Admin conectado.');
} catch (e) {
  console.warn('Firebase Admin não configurado:', e.message);
}

// ── Rota de saúde
app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Hélo Gourmet Backend' }));

// ── Criar preferência de pagamento (chamado pelo site do cliente)
app.post('/criar-pagamento', async (req, res) => {
  try {
    const { itens, total } = req.body;
    if (!itens || itens.length === 0) {
      return res.status(400).json({ erro: 'Carrinho vazio.' });
    }

    // Salva pedido no Firestore com status "pendente"
    let pedidoId = null;
    if (db) {
      const ref = await db.collection('pedidos').add({
        itens,
        total,
        status: 'pendente',
        criadoEm: Timestamp.now()
      });
      pedidoId = ref.id;
    }

    // Cria preferência no Mercado Pago
    const preference = new Preference(mp);
    const resultado = await preference.create({
      body: {
        items: itens.map(item => ({
          title: item.nome,
          quantity: item.quantidade,
          unit_price: Number(item.preco),
          currency_id: 'BRL'
        })),
        back_urls: {
          success: `${process.env.SITE_URL || 'https://cardapiohelogourmet.web.app'}/sucesso.html`,
          failure: `${process.env.SITE_URL || 'https://cardapiohelogourmet.web.app'}/erro.html`,
          pending: `${process.env.SITE_URL || 'https://cardapiohelogourmet.web.app'}/pendente.html`
        },
        auto_return: 'approved',
        notification_url: `${process.env.BACKEND_URL || 'https://seu-backend.onrender.com'}/webhook`,
        external_reference: pedidoId || 'sem-id',
        statement_descriptor: 'HELO GOURMET'
      }
    });

    res.json({
      init_point: resultado.init_point,       // URL de pagamento (produção)
      sandbox_init_point: resultado.sandbox_init_point, // URL de teste
      pedidoId
    });

  } catch (err) {
    console.error('Erro ao criar pagamento:', err);
    res.status(500).json({ erro: 'Erro ao criar pagamento.' });
  }
});

// ── Webhook — Mercado Pago notifica aqui quando pagamento é confirmado
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responde imediatamente para o MP não reenviar

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;

  try {
    // Busca detalhes do pagamento no MP
    const payment = new Payment(mp);
    const pagamento = await payment.get({ id: data.id });

    const status = pagamento.status;           // approved, pending, rejected
    const pedidoId = pagamento.external_reference;
    const pagamentoId = String(pagamento.id);

    console.log(`Webhook recebido: pedido=${pedidoId} status=${status}`);

    if (!db || !pedidoId || pedidoId === 'sem-id') return;

    // Atualiza status do pedido no Firestore
    const novoStatus = status === 'approved' ? 'pago'
                     : status === 'rejected' ? 'cancelado'
                     : 'pendente';

    await db.collection('pedidos').doc(pedidoId).update({
      status: novoStatus,
      pagamentoId,
      pagamentoStatus: status,
      atualizadoEm: Timestamp.now()
    });

    console.log(`Pedido ${pedidoId} atualizado para: ${novoStatus}`);

  } catch (err) {
    console.error('Erro no webhook:', err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
