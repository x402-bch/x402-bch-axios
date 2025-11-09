# x402-bch-axios

JavaScript helpers for handling HTTP 402 responses against Bitcoin Cash powered
x402 endpoints. This package ports the `withPaymentInterceptor` experience from
the TypeScript `x402-axios` client and adapts it for BCH UTXO payments.

## Installation

```bash
npm install x402-bch-axios minimal-slp-wallet axios
```

The library depends on `minimal-slp-wallet` and assumes you are using ESM
(`type: module`) in your project.

## Usage

```javascript
import axios from 'axios'
import {
  createSigner,
  withPaymentInterceptor
} from 'x402-bch-axios'

const signer = createSigner(process.env.PRIVATE_KEY_WIF, 2000)

const api = withPaymentInterceptor(
  axios.create({ baseURL: 'https://example.com' }),
  signer,
  // Optional payment requirements selector; defaults to BCH utxo
  undefined,
  // Optional BCH wallet config matching minimal-slp-wallet expectations
  {
    apiType: 'consumer-api',
    bchServerURL: 'https://free-bch.fullstack.cash'
  }
)

// Get data from an endpoint that requires 402 payment for access.
const response = await api.get('/weather')
console.log(response.data)
```

## API

- `createSigner(privateKeyWIF, paymentAmountSats)` — build a BCH signer used to
  sign x402 payment payloads and control default spend amounts.
- `withPaymentInterceptor(axiosInstance, signer, selector?, config?)` — attach
  an interceptor that:
  - waits for a 402 response,
  - selects the BCH `utxo` payment requirement (or uses your selector),
  - funds or reuses a tracked UTXO,
  - replays the request with the `X-PAYMENT` header.
- `selectPaymentRequirements(accepts)` — utility for filtering BCH
  requirements.
- `createPaymentHeader(...)` — exposed for advanced integrations that need
  direct x402 payload handling.

## Licence

[MIT](LICENSE.md)
