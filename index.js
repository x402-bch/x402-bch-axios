/*
  x402-bch-axios

  A BCH-focused port of the x402 Axios interceptor. The API mirrors the
  TypeScript `withPaymentInterceptor` experience but intentionally omits
  multi-network support and config typings that are not relevant for BCH.

  Differences from the TypeScript implementation:
  - Only supports BCH `utxo` payment requirements and BCH signers.
  - Accepts an optional BCH server config instead of the generic `X402Config`.
  - Does not expose multi-network signer helpers or type exports.
*/

// External dependencies
import BCHWallet from 'minimal-slp-wallet'
import RetryQueue from '@chris.troutner/retry-queue'

const dependencies = {
  BCHWallet,
  RetryQueue
}

export function __setDependencies (overrides = {}) {
  Object.assign(dependencies, overrides)
}

export function __resetDependencies () {
  dependencies.BCHWallet = BCHWallet
  dependencies.RetryQueue = RetryQueue
}

const currentUtxo = {
  txid: null,
  vout: null,
  satsLeft: 0
}

/**
 * Creates a BCH signer from a private key in WIF format.
 *
 * @param {string} privateKeyWIF - Private key in Wallet Import Format (WIF)
 * @param {number} paymentAmountSats - Default spend amount for queued payments
 * @returns {{ ecpair: any, address: string, wif: string, paymentAmountSats: number, signMessage: (message: string) => string }}
 */
export function createSigner (privateKeyWIF, paymentAmountSats) {
  const wallet = new dependencies.BCHWallet()
  const bchjs = wallet.bchjs

  const ecpair = bchjs.ECPair.fromWIF(privateKeyWIF)
  const address = bchjs.ECPair.toCashAddress(ecpair)

  return {
    ecpair,
    address,
    wif: privateKeyWIF,
    paymentAmountSats,
    signMessage (message) {
      return bchjs.BitcoinCash.signMessageWithPrivKey(privateKeyWIF, message)
    }
  }
}

export const createBCHSigner = createSigner

/**
 * Normalizes network identifier to support both v1 and v2 formats.
 * v1 uses 'bch', v2 uses CAIP-2 format 'bip122:000000000000000000651ef99cb9fcbe'
 *
 * @param {string} network - Network identifier
 * @returns {boolean} True if the network is BCH (mainnet)
 */
function isBCHNetwork (network) {
  if (!network) return false
  // v1 format
  if (network === 'bch') return true
  // v2 CAIP-2 format for BCH mainnet
  if (network === 'bip122:000000000000000000651ef99cb9fcbe') return true
  // v2 CAIP-2 format pattern matching (bip122:*)
  if (network.startsWith('bip122:')) return true
  return false
}

/**
 * Selects BCH `utxo` payment requirements from a 402 accepts array.
 * Supports both v1 ('bch') and v2 (CAIP-2 'bip122:*') network formats.
 *
 * @param {Array} accepts - Array of payment requirements objects
 * @returns {Object} First BCH `utxo` payment requirement
 */
export function selectPaymentRequirements (accepts = []) {
  const bchRequirements = accepts.filter(req => {
    return isBCHNetwork(req?.network) && req?.scheme === 'utxo'
  })

  if (bchRequirements.length === 0) {
    throw new Error('No BCH payment requirements found in 402 response')
  }

  return bchRequirements[0]
}

/**
 * Builds the PAYMENT-SIGNATURE header payload for BCH transfers.
 *
 * @param {ReturnType<typeof createSigner>} signer
 * @param {Object} paymentRequirements
 * @param {number} x402Version
 * @param {string|null} txid
 * @param {number|null} vout
 * @param {Object|null} resource - Optional ResourceInfo object
 * @param {Object|null} extensions - Optional extensions object
 * @returns {Promise<string>}
 */
export async function createPaymentHeader (
  signer,
  paymentRequirements,
  x402Version = 2,
  txid = null,
  vout = null,
  resource = null,
  extensions = null
) {
  // Support both v1 (minAmountRequired) and v2 (amount) field names
  const amountRequired = paymentRequirements.amount || paymentRequirements.minAmountRequired

  const authorization = {
    from: signer.address,
    to: paymentRequirements.payTo,
    value: amountRequired,
    txid,
    vout,
    amount: signer.paymentAmountSats
  }

  const messageToSign = JSON.stringify(authorization)
  const signature = signer.signMessage(messageToSign)

  // Build accepted PaymentRequirements object
  const accepted = {
    scheme: paymentRequirements.scheme || 'utxo',
    network: paymentRequirements.network || 'bip122:000000000000000000651ef99cb9fcbe',
    amount: amountRequired,
    asset: paymentRequirements.asset,
    payTo: paymentRequirements.payTo,
    maxTimeoutSeconds: paymentRequirements.maxTimeoutSeconds,
    extra: paymentRequirements.extra || {}
  }

  // Build v2 PaymentPayload structure
  const paymentHeader = {
    x402Version,
    ...(resource && { resource }),
    accepted,
    payload: {
      signature,
      authorization
    },
    ...(extensions && { extensions })
  }

  return JSON.stringify(paymentHeader)
}

async function sendPayment (signer, paymentRequirements, bchServerConfig = {}) {
  const { apiType, bchServerURL } = bchServerConfig
  // Support both v1 (minAmountRequired) and v2 (amount) field names
  const amountRequired = paymentRequirements.amount || paymentRequirements.minAmountRequired
  const paymentAmountSats = signer.paymentAmountSats || amountRequired

  const bchWallet = new dependencies.BCHWallet(signer.wif, {
    interface: apiType,
    restURL: bchServerURL
  })
  // console.log(`sendPayment() - interface: ${apiType}, restURL: ${bchServerURL}, wif: ${signer.wif}, payTo: ${paymentRequirements.payTo}, paymentAmountSats: ${paymentAmountSats}`)
  console.log(`Sending ${paymentAmountSats} for x402 API payment to ${paymentRequirements.payTo}`)
  await bchWallet.initialize()

  const retryQueue = new dependencies.RetryQueue()
  const receivers = [
    {
      address: paymentRequirements.payTo,
      amountSat: paymentAmountSats
    }
  ]

  const txid = await retryQueue.addToQueue(bchWallet.send.bind(bchWallet), receivers)

  return {
    txid,
    vout: 0,
    satsSent: paymentAmountSats
  }
}

/**
 * Adds a payment interceptor to an axios instance.
 *
 * @param {import('axios').AxiosInstance} axiosInstance
 * @param {ReturnType<typeof createSigner>} signer
 * @param {Function|Object} paymentRequirementsSelectorOrConfig - Optional selector or BCH server config
 * @param {Object} maybeConfig - Optional BCH server config when a selector is provided
 * @returns {import('axios').AxiosInstance}
 */
export function withPaymentInterceptor (
  axiosInstance,
  signer,
  paymentRequirementsSelectorOrConfig,
  maybeConfig
) {
  let paymentRequirementsSelector = selectPaymentRequirements
  let bchServerConfig = {}

  if (typeof paymentRequirementsSelectorOrConfig === 'function') {
    paymentRequirementsSelector = paymentRequirementsSelectorOrConfig
    if (maybeConfig) {
      bchServerConfig = maybeConfig
    }
  } else if (paymentRequirementsSelectorOrConfig) {
    bchServerConfig = paymentRequirementsSelectorOrConfig
  }

  axiosInstance.interceptors.response.use(
    response => response,
    async error => {
      if (!error.response || error.response.status !== 402) {
        return Promise.reject(error)
      }

      try {
        const originalConfig = error.config
        if (!originalConfig || !originalConfig.headers) {
          return Promise.reject(new Error('Missing axios request configuration'))
        }

        if (originalConfig.__is402Retry) {
          return Promise.reject(error)
        }

        // Parse payment requirements - v2 can come from header, v1 from body
        let paymentRequired = null
        let x402Version = 1
        let accepts = []
        let resource = null
        let extensions = null

        // Try v2 PAYMENT-REQUIRED header first (base64-encoded)
        const paymentRequiredHeader = error.response.headers['payment-required'] ||
                                      error.response.headers['PAYMENT-REQUIRED']
        if (paymentRequiredHeader) {
          try {
            const decoded = Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8')
            paymentRequired = JSON.parse(decoded)
            x402Version = paymentRequired.x402Version || 2
            accepts = paymentRequired.accepts || []
            resource = paymentRequired.resource
            extensions = paymentRequired.extensions
          } catch (parseError) {
            // If header parsing fails, fall back to body
          }
        }

        // Fall back to body format (v1 or v2)
        if (!paymentRequired) {
          const body = error.response.data || {}
          x402Version = body.x402Version || 1
          accepts = body.accepts || []
          resource = body.resource
          extensions = body.extensions
        }

        if (!accepts || !Array.isArray(accepts) || accepts.length === 0) {
          return Promise.reject(new Error('No payment requirements found in 402 response'))
        }

        const paymentRequirements = paymentRequirementsSelector(accepts)
        // Support both v1 (minAmountRequired) and v2 (amount) field names
        // Convert to number for calculations (v2 uses strings, v1 uses numbers)
        const cost = Number(paymentRequirements.amount || paymentRequirements.minAmountRequired)

        let txid = null
        let vout = null
        let satsLeft = null

        if (!currentUtxo.txid || currentUtxo.satsLeft < cost) {
          const payment = await internals.sendPayment(
            signer,
            paymentRequirements,
            bchServerConfig
          )
          txid = payment.txid
          vout = payment.vout
          satsLeft = payment.satsSent - cost
        } else {
          txid = currentUtxo.txid
          vout = currentUtxo.vout
          satsLeft = currentUtxo.satsLeft - cost
        }

        currentUtxo.txid = txid
        currentUtxo.vout = vout
        currentUtxo.satsLeft = satsLeft

        const paymentHeader = await createPaymentHeader(
          signer,
          paymentRequirements,
          x402Version || 2,
          txid,
          vout,
          resource,
          extensions
        )

        originalConfig.__is402Retry = true
        originalConfig.headers['PAYMENT-SIGNATURE'] = paymentHeader
        originalConfig.headers['Access-Control-Expose-Headers'] = 'PAYMENT-RESPONSE'

        const secondResponse = await axiosInstance.request(originalConfig)
        return secondResponse
      } catch (paymentError) {
        return Promise.reject(paymentError)
      }
    }
  )

  return axiosInstance
}

const internals = {
  dependencies,
  currentUtxo,
  sendPayment
}

export function __resetCurrentUtxo () {
  currentUtxo.txid = null
  currentUtxo.vout = null
  currentUtxo.satsLeft = 0
}

export function __resetInternals () {
  internals.sendPayment = sendPayment
  __resetDependencies()
  __resetCurrentUtxo()
}

export const __internals = internals
