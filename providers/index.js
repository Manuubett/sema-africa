// A provider does two things: send the M-Pesa prompt (startStk) and check the result (query).
// Everything else (prices, discounts, enrolment) lives in routes/payments.js.
// When Pesapal is approved, add providers/pesapal.js with the same two functions.
const mock = {
  name: 'mock',
  async startStk() { return { checkoutId: 'MOCK' + Date.now() }; },
  async query() { return { state: 'pending' }; },   // test mode is completed with /simulate instead
};
module.exports = () => (process.env.PAYMENTS_MODE === 'live' ? require('./daraja') : mock);
