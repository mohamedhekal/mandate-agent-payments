import { PayPalLive } from './live.js';
import { PayPalSimulator } from './simulator.js';

/** Live SANDBOX API when credentials are present, otherwise the local simulator. Both share one interface. */
export function createPayPal(config) {
  const { clientId, clientSecret, payeeEmail } = config.paypal;
  if (clientId && clientSecret) return new PayPalLive({ clientId, clientSecret, payeeEmail, publicUrl: config.publicUrl });
  return new PayPalSimulator({ publicUrl: config.publicUrl });
}
