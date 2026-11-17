// A provider does two things for M-Pesa: send the prompt (startStk) and check the result (query).
// Card payments (IntaSend) use createCheckout and queryInvoice instead. Everything else lives in routes/payments.js.
const mock = {
  name: 'mock',
  async startStk() { return { checkoutId: 'MOCK' + Date.now() }; },
  async query() { return { state: 'pending' }; },   // test mode is completed with /simulate instead
  async createCheckout() { return { checkoutId: 'MOCKCARD' + Date.now(), url: '' }; },
  async queryInvoice() { return { state: 'pending' }; },
};
const live = () => process.env.PAYMENTS_MODE === 'live';
module.exports = () => (live() ? require('./daraja') : mock);
module.exports.card = () => (live() ? require('./intasend') : mock);
