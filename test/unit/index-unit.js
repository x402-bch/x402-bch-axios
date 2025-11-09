/*
  Unit tests for the index.js BCH Axios interceptor.
*/

// npm libraries
import { assert } from 'chai'
import sinon from 'sinon'
import cloneDeep from 'lodash.clonedeep'

// Unit under test
import {
  createSigner,
  selectPaymentRequirements,
  createPaymentHeader,
  withPaymentInterceptor,
  __setDependencies,
  __resetDependencies,
  __resetInternals,
  __internals
} from '../../index.js'

describe('#index.js', () => {
  let sandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    __resetInternals()
  })

  afterEach(() => {
    sandbox.restore()
    __resetInternals()
  })

  describe('#createSigner', () => {
    it('should create a signer with derived address and signer method', () => {
      const mockEcpair = { ecpair: true }
      const fromWIFStub = sandbox.stub().returns(mockEcpair)
      const toCashAddressStub = sandbox.stub().returns('bitcoincash:qptest')
      const signMessageStub = sandbox.stub().returns('signed-message')

      const walletStub = sandbox.stub().returns({
        bchjs: {
          ECPair: {
            fromWIF: fromWIFStub,
            toCashAddress: toCashAddressStub
          },
          BitcoinCash: {
            signMessageWithPrivKey: signMessageStub
          }
        }
      })

      __setDependencies({ BCHWallet: walletStub })

      const signer = createSigner('test-wif', 1500)

      assert.isTrue(walletStub.calledOnce)
      assert.strictEqual(fromWIFStub.firstCall.args[0], 'test-wif')
      assert.strictEqual(toCashAddressStub.firstCall.args[0], mockEcpair)

      assert.equal(signer.address, 'bitcoincash:qptest')
      assert.equal(signer.paymentAmountSats, 1500)
      assert.equal(signer.wif, 'test-wif')
      assert.strictEqual(signer.ecpair, mockEcpair)

      const signature = signer.signMessage('message-to-sign')
      assert.equal(signature, 'signed-message')
      assert.deepEqual(signMessageStub.firstCall.args, ['test-wif', 'message-to-sign'])

      __resetDependencies()
    })
  })

  describe('#selectPaymentRequirements', () => {
    it('should select the first BCH utxo requirement', () => {
      const accepts = [
        { network: 'eth', scheme: 'account' },
        { network: 'bch', scheme: 'utxo', payTo: 'addr1' },
        { network: 'bch', scheme: 'account' }
      ]

      const req = selectPaymentRequirements(accepts)
      assert.deepEqual(req, { network: 'bch', scheme: 'utxo', payTo: 'addr1' })
    })

    it('should throw if no BCH utxo requirement exists', () => {
      assert.throws(
        () => selectPaymentRequirements([{ network: 'btc', scheme: 'utxo' }]),
        /No BCH payment requirements/
      )
    })
  })

  describe('#createPaymentHeader', () => {
    it('should build a valid payment header payload', async () => {
      const signer = {
        address: 'bitcoincash:qptest',
        paymentAmountSats: 2000,
        signMessage: sandbox.stub().returns('mock-signature')
      }

      const paymentRequirements = {
        payTo: 'bitcoincash:qprecv',
        minAmountRequired: 1500,
        scheme: 'utxo',
        network: 'bch'
      }

      const header = await createPaymentHeader(
        signer,
        paymentRequirements,
        2,
        'tx123',
        0
      )

      const parsed = JSON.parse(header)
      assert.deepEqual(parsed, {
        x402Version: 2,
        scheme: 'utxo',
        network: 'bch',
        payload: {
          signature: 'mock-signature',
          authorization: {
            from: 'bitcoincash:qptest',
            to: 'bitcoincash:qprecv',
            value: 1500,
            txid: 'tx123',
            vout: 0,
            amount: 2000
          }
        }
      })
      assert.isTrue(signer.signMessage.calledOnce)
    })
  })

  describe('#withPaymentInterceptor', () => {
    function createAxiosInstance () {
      return {
        interceptors: {
          response: {
            use: sandbox.stub()
          }
        },
        request: sandbox.stub()
      }
    }

    function createSignerStub () {
      return {
        address: 'bitcoincash:qptest',
        paymentAmountSats: 2000,
        signMessage: sandbox.stub().returns('signature')
      }
    }

    const basePaymentRequirements = {
      network: 'bch',
      scheme: 'utxo',
      payTo: 'bitcoincash:qprecv',
      minAmountRequired: 1500
    }

    function create402Error (overrides = {}) {
      const defaultError = {
        response: {
          status: 402,
          data: {
            x402Version: 1,
            accepts: [cloneDeep(basePaymentRequirements)]
          }
        },
        config: {
          headers: {}
        }
      }
      return Object.assign(defaultError, overrides)
    }

    it('should rethrow non-402 errors', async () => {
      const axiosInstance = createAxiosInstance()
      const signer = createSignerStub()

      withPaymentInterceptor(axiosInstance, signer)

      const [, errorHandler] = axiosInstance.interceptors.response.use.firstCall.args
      const non402Error = { response: { status: 400 } }

      try {
        await errorHandler(non402Error)
        assert.fail('Expected rejection')
      } catch (err) {
        assert.strictEqual(err, non402Error)
      }
    })

    it('should reject when axios config headers are missing', async () => {
      const axiosInstance = createAxiosInstance()
      const signer = createSignerStub()

      withPaymentInterceptor(axiosInstance, signer)

      const [, errorHandler] = axiosInstance.interceptors.response.use.firstCall.args
      const error = create402Error({
        config: {}
      })

      try {
        await errorHandler(error)
        assert.fail('Expected rejection')
      } catch (err) {
        assert.match(err.message, /Missing axios request configuration/)
      }
    })

    it('should reject when no payment requirements are provided', async () => {
      const axiosInstance = createAxiosInstance()
      const signer = createSignerStub()

      withPaymentInterceptor(axiosInstance, signer)

      const [, errorHandler] = axiosInstance.interceptors.response.use.firstCall.args
      const error = create402Error({
        response: { status: 402, data: { accepts: [] } }
      })

      try {
        await errorHandler(error)
        assert.fail('Expected rejection')
      } catch (err) {
        assert.match(err.message, /No payment requirements/)
      }
    })

    it('should send payment, attach headers, and retry request', async () => {
      const axiosInstance = createAxiosInstance()
      const signer = createSignerStub()
      signer.signMessage.returns('signed')

      const sendPaymentStub = sandbox
        .stub()
        .resolves({ txid: 'tx123', vout: 0, satsSent: 2000 })
      __internals.sendPayment = sendPaymentStub

      axiosInstance.request.resolves({ data: 'ok' })

      withPaymentInterceptor(axiosInstance, signer)

      const [, errorHandler] = axiosInstance.interceptors.response.use.firstCall.args
      const error = create402Error()

      const response = await errorHandler(error)

      assert.deepEqual(response, { data: 'ok' })
      assert.isTrue(sendPaymentStub.calledOnce)
      assert.isTrue(axiosInstance.request.calledOnce)

      const updatedConfig = axiosInstance.request.firstCall.args[0]
      assert.isTrue(updatedConfig.__is402Retry)
      assert.property(updatedConfig.headers, 'X-PAYMENT')
      assert.propertyVal(
        updatedConfig.headers,
        'Access-Control-Expose-Headers',
        'X-PAYMENT-RESPONSE'
      )

      const headerPayload = JSON.parse(updatedConfig.headers['X-PAYMENT'])
      assert.equal(headerPayload.payload.authorization.txid, 'tx123')
      assert.equal(__internals.currentUtxo.txid, 'tx123')
      assert.equal(__internals.currentUtxo.satsLeft, 500)
    })

    it('should reuse cached utxo when sufficient balance remains', async () => {
      const axiosInstance = createAxiosInstance()
      const signer = createSignerStub()
      signer.signMessage.returns('signed')

      __internals.currentUtxo.txid = 'cached'
      __internals.currentUtxo.vout = 1
      __internals.currentUtxo.satsLeft = 2_000

      const sendPaymentStub = sandbox.stub()
      __internals.sendPayment = sendPaymentStub

      axiosInstance.request.resolves({ status: 200 })

      withPaymentInterceptor(axiosInstance, signer)

      const [, errorHandler] = axiosInstance.interceptors.response.use.firstCall.args
      const error = create402Error()

      const result = await errorHandler(error)
      assert.deepEqual(result, { status: 200 })

      assert.isTrue(sendPaymentStub.notCalled)
      assert.equal(__internals.currentUtxo.txid, 'cached')
      assert.equal(__internals.currentUtxo.satsLeft, 500)
    })
  })
})
