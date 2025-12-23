# x402-bch-axios

JavaScript helpers for handling HTTP 402 responses against Bitcoin Cash powered
x402 endpoints. This package ports the `withPaymentInterceptor` experience from
the TypeScript `x402-axios` client and adapts it for BCH UTXO payments.

**Version 2.0+**: This library now supports x402-bch protocol v2, which includes
CAIP-2 network identifiers, updated header names, and restructured payment payloads.
Backward compatibility with v1 responses is maintained.

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
  - replays the request with the `PAYMENT-SIGNATURE` header (v2) or `X-PAYMENT` header (v1).
- `selectPaymentRequirements(accepts)` — utility for filtering BCH
  requirements. Supports both v1 (`bch`) and v2 CAIP-2 (`bip122:*`) network formats.
- `createPaymentHeader(signer, paymentRequirements, x402Version, txid, vout, resource?, extensions?)` — exposed for advanced integrations that need
  direct x402 payload handling. Returns v2 format by default.

## Protocol Version 2 Changes

This library supports x402-bch protocol v2 with the following changes:

### Header Names
- **v2**: `PAYMENT-SIGNATURE` (replaces `X-PAYMENT`)
- **v2**: `PAYMENT-RESPONSE` (replaces `X-PAYMENT-RESPONSE`)

### Network Identifiers
- **v1**: `bch` (simple string)
- **v2**: `bip122:000000000000000000651ef99cb9fcbe` (CAIP-2 format for BCH mainnet)

The library automatically detects and supports both formats.

### Payment Payload Structure

**v2 Format:**
```json
{
  "x402Version": 2,
  "resource": {
    "url": "http://localhost:4021/weather",
    "description": "Access to weather data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "utxo",
    "network": "bip122:000000000000000000651ef99cb9fcbe",
    "amount": "1000",
    "asset": "0x0000000000000000000000000000000000000001",
    "payTo": "bitcoincash:...",
    "maxTimeoutSeconds": 60,
    "extra": {}
  },
  "payload": {
    "signature": "...",
    "authorization": {
      "from": "bitcoincash:...",
      "to": "bitcoincash:...",
      "value": "1000",
      "txid": "...",
      "vout": 0,
      "amount": "2000"
    }
  },
  "extensions": {}
}
```

**Key differences from v1:**
- Removed top-level `scheme` and `network` fields
- Added `accepted` field containing the selected PaymentRequirements
- Added optional `resource` and `extensions` fields
- Field name change: `minAmountRequired` → `amount` (library supports both for compatibility)

### Response Parsing

The library supports both v1 and v2 response formats:
- **v2**: Parses from `PAYMENT-REQUIRED` header (base64-encoded JSON)
- **v1**: Falls back to response body format

## Migration from v1

If you're upgrading from v1, the library maintains backward compatibility:
- v1 responses are automatically detected and handled
- v1 field names (`minAmountRequired`, `bch` network) are supported
- No code changes required for basic usage

However, for full v2 support:
- Update your server to send v2 responses
- Use CAIP-2 network identifiers in payment requirements
- Expect `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` headers

## Licence

[MIT](LICENSE.md)
