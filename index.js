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
  const wallet = new BCHWallet()
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
 * Selects BCH `utxo` payment requirements from a 402 accepts array.
 *
 * @param {Array} accepts - Array of payment requirements objects
 * @returns {Object} First BCH `utxo` payment requirement
 */
export function selectPaymentRequirements (accepts = []) {
  const bchRequirements = accepts.filter(req => {
    return req?.network === 'bch' && req?.scheme === 'utxo'
  })

  if (bchRequirements.length === 0) {
    throw new Error('No BCH payment requirements found in 402 response')
  }

  return bchRequirements[0]
}

/**
 * Builds the X-PAYMENT header payload for BCH transfers.
 *
 * @param {ReturnType<typeof createSigner>} signer
 * @param {Object} paymentRequirements
 * @param {number} x402Version
 * @param {string|null} txid
 * @param {number|null} vout
 * @returns {Promise<string>}
 */
export async function createPaymentHeader (
  signer,
  paymentRequirements,
  x402Version = 1,
  txid = null,
  vout = null
) {

  const authorization = {
    from: signer.address,
    to: paymentRequirements.payTo,
    value: paymentRequirements.minAmountRequired,
    txid,
    vout,
    amount: signer.paymentAmountSats
  }

  const messageToSign = JSON.stringify(authorization)
  const signature = signer.signMessage(messageToSign)

  const paymentHeader = {
    x402Version,
    scheme: paymentRequirements.scheme || 'utxo',
    network: paymentRequirements.network || 'bch',
    payload: {
      signature,
      authorization
    }
  }

  return JSON.stringify(paymentHeader)
}

async function sendPayment (signer, paymentRequirements, bchServerConfig = {}) {
  const { apiType, bchServerURL } = bchServerConfig
  const paymentAmountSats = signer.paymentAmountSats || paymentRequirements.minAmountRequired

  const bchWallet = new BCHWallet(signer.wif, {
    interface: apiType,
    restURL: bchServerURL
  })
  await bchWallet.initialize()

  const retryQueue = new RetryQueue()
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

        const { x402Version, accepts } = error.response.data || {}
        if (!accepts || !Array.isArray(accepts) || accepts.length === 0) {
          return Promise.reject(new Error('No payment requirements found in 402 response'))
        }

        const paymentRequirements = paymentRequirementsSelector(accepts)
        const cost = paymentRequirements.minAmountRequired

        let txid = null
        let vout = null
        let satsLeft = null

        if (!currentUtxo.txid || currentUtxo.satsLeft < cost) {
          const payment = await sendPayment(signer, paymentRequirements, bchServerConfig)
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
          x402Version || 1,
          txid,
          vout
        )

        originalConfig.__is402Retry = true
        originalConfig.headers['X-PAYMENT'] = paymentHeader
        originalConfig.headers['Access-Control-Expose-Headers'] = 'X-PAYMENT-RESPONSE'

        const secondResponse = await axiosInstance.request(originalConfig)
        return secondResponse
      } catch (paymentError) {
        return Promise.reject(paymentError)
      }
    }
  )

  return axiosInstance
}
