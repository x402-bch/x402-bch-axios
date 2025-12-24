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
    it('should select the first BCH utxo requirement (v1 format)', () => {
      const accepts = [
        { network: 'eth', scheme: 'account' },
        { network: 'bch', scheme: 'utxo', payTo: 'addr1' },
        { network: 'bch', scheme: 'account' }
      ]

      const req = selectPaymentRequirements(accepts)
      assert.deepEqual(req, { network: 'bch', scheme: 'utxo', payTo: 'addr1' })
    })

    it('should select the first BCH utxo requirement (v2 CAIP-2 format)', () => {
      const accepts = [
        { network: 'eip155:84532', scheme: 'exact' },
        { network: 'bip122:000000000000000000651ef99cb9fcbe', scheme: 'utxo', payTo: 'addr1' },
        { network: 'bch', scheme: 'utxo', payTo: 'addr2' }
      ]

      const req = selectPaymentRequirements(accepts)
      assert.deepEqual(req, { network: 'bip122:000000000000000000651ef99cb9fcbe', scheme: 'utxo', payTo: 'addr1' })
    })

    it('should throw if no BCH utxo requirement exists', () => {
      assert.throws(
        () => selectPaymentRequirements([{ network: 'btc', scheme: 'utxo' }]),
        /No BCH payment requirements/
      )
    })
  })

  describe('#createPaymentHeader', () => {
    it('should build a valid v2 payment header payload', async () => {
      const signer = {
        address: 'bitcoincash:qptest',
        paymentAmountSats: 2000,
        signMessage: sandbox.stub().returns('mock-signature')
      }

      const paymentRequirements = {
        payTo: 'bitcoincash:qprecv',
        amount: '1500',
        scheme: 'utxo',
        network: 'bip122:000000000000000000651ef99cb9fcbe',
        asset: '0x0000000000000000000000000000000000000001',
        maxTimeoutSeconds: 60,
        extra: {}
      }

      const resource = {
        url: 'http://localhost:4021/weather',
        description: 'Access to weather data',
        mimeType: 'application/json'
      }

      const header = await createPaymentHeader(
        signer,
        paymentRequirements,
        2,
        'tx123',
        0,
        resource
      )

      const parsed = JSON.parse(header)
      assert.equal(parsed.x402Version, 2)
      assert.deepEqual(parsed.resource, resource)
      assert.deepEqual(parsed.accepted, {
        scheme: 'utxo',
        network: 'bip122:000000000000000000651ef99cb9fcbe',
        amount: '1500',
        asset: '0x0000000000000000000000000000000000000001',
        payTo: 'bitcoincash:qprecv',
        maxTimeoutSeconds: 60,
        extra: {}
      })
      assert.deepEqual(parsed.payload, {
        signature: 'mock-signature',
        authorization: {
          from: 'bitcoincash:qptest',
          to: 'bitcoincash:qprecv',
          value: '1500',
          txid: 'tx123',
          vout: 0,
          amount: 2000
        }
      })
      // v2 should not have top-level scheme/network
      assert.isUndefined(parsed.scheme)
      assert.isUndefined(parsed.network)
      assert.isTrue(signer.signMessage.calledOnce)
    })

    it('should support v1 minAmountRequired field for backward compatibility', async () => {
      const signer = {
        address: 'bitcoincash:qptest',
        paymentAmountSats: 2000,
        signMessage: sandbox.stub().returns('mock-signature')
      }

      const paymentRequirements = {
        payTo: 'bitcoincash:qprecv',
        minAmountRequired: 1500, // v1 field name
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
      assert.equal(parsed.accepted.amount, 1500)
      assert.equal(parsed.payload.authorization.value, 1500)
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
      network: 'bip122:000000000000000000651ef99cb9fcbe',
      scheme: 'utxo',
      payTo: 'bitcoincash:qprecv',
      amount: '1500',
      asset: '0x0000000000000000000000000000000000000001',
      maxTimeoutSeconds: 60,
      extra: {}
    }

    const baseResource = {
      url: 'http://localhost:4021/weather',
      description: 'Access to weather data',
      mimeType: 'application/json'
    }

    function create402Error (overrides = {}) {
      const defaultError = {
        response: {
          status: 402,
          headers: {},
          data: {
            x402Version: 2,
            resource: cloneDeep(baseResource),
            accepts: [cloneDeep(basePaymentRequirements)],
            extensions: {}
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
        response: { status: 402, headers: {}, data: { accepts: [] } }
      })

      try {
        await errorHandler(error)
        assert.fail('Expected rejection')
      } catch (err) {
        // Should reject with "No payment requirements found in 402 response"
        // or "No BCH payment requirements found in 402 response" from selector
        assert.match(err.message, /No.*payment requirements/)
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

      // First call (check my tab) returns 402, second call (with UTXO) succeeds
      axiosInstance.request
        .onFirstCall()
        .rejects(create402Error())
        .onSecondCall()
        .resolves({ data: 'ok' })

      withPaymentInterceptor(axiosInstance, signer)

      const [, errorHandler] = axiosInstance.interceptors.response.use.firstCall.args
      const error = create402Error()

      const response = await errorHandler(error)

      assert.deepEqual(response, { data: 'ok' })
      assert.isTrue(sendPaymentStub.calledOnce)
      assert.isTrue(axiosInstance.request.calledTwice)

      // Check the second call (with UTXO) - first call was check my tab
      const updatedConfig = axiosInstance.request.secondCall.args[0]
      assert.isTrue(updatedConfig.__is402Retry)
      assert.property(updatedConfig.headers, 'PAYMENT-SIGNATURE')
      assert.propertyVal(
        updatedConfig.headers,
        'Access-Control-Expose-Headers',
        'PAYMENT-RESPONSE'
      )

      const headerPayload = JSON.parse(updatedConfig.headers['PAYMENT-SIGNATURE'])
      assert.equal(headerPayload.x402Version, 2)
      assert.deepEqual(headerPayload.accepted, basePaymentRequirements)
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

    it('should parse v2 response from PAYMENT-REQUIRED header', async () => {
      const axiosInstance = createAxiosInstance()
      const signer = createSignerStub()
      signer.signMessage.returns('signed')

      const sendPaymentStub = sandbox
        .stub()
        .resolves({ txid: 'tx123', vout: 0, satsSent: 2000 })
      __internals.sendPayment = sendPaymentStub

      // First call (check my tab) returns 402, second call (with UTXO) succeeds
      axiosInstance.request
        .onFirstCall()
        .rejects({
          response: {
            status: 402,
            headers: {},
            data: {
              x402Version: 2,
              accepts: [cloneDeep(basePaymentRequirements)]
            }
          },
          config: { headers: {} }
        })
        .onSecondCall()
        .resolves({ data: 'ok' })

      withPaymentInterceptor(axiosInstance, signer)

      const [, errorHandler] = axiosInstance.interceptors.response.use.firstCall.args

      // Create v2 response with PAYMENT-REQUIRED header
      const paymentRequired = {
        x402Version: 2,
        resource: baseResource,
        accepts: [cloneDeep(basePaymentRequirements)],
        extensions: {}
      }
      const headerValue = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')

      const error = {
        response: {
          status: 402,
          headers: {
            'payment-required': headerValue
          },
          data: {}
        },
        config: {
          headers: {}
        }
      }

      const response = await errorHandler(error)

      assert.deepEqual(response, { data: 'ok' })
      assert.isTrue(sendPaymentStub.calledOnce)
      assert.isTrue(axiosInstance.request.calledTwice)

      // Check the second call (with UTXO) - first call was check my tab
      const updatedConfig = axiosInstance.request.secondCall.args[0]
      const headerPayload = JSON.parse(updatedConfig.headers['PAYMENT-SIGNATURE'])
      assert.equal(headerPayload.x402Version, 2)
      assert.deepEqual(headerPayload.resource, baseResource)
    })

    it('should support v1 response format for backward compatibility', async () => {
      const axiosInstance = createAxiosInstance()
      const signer = createSignerStub()
      signer.signMessage.returns('signed')

      const sendPaymentStub = sandbox
        .stub()
        .resolves({ txid: 'tx123', vout: 0, satsSent: 2000 })
      __internals.sendPayment = sendPaymentStub

      // First call (check my tab) returns 402, second call (with UTXO) succeeds
      axiosInstance.request
        .onFirstCall()
        .rejects({
          response: {
            status: 402,
            headers: {},
            data: {
              x402Version: 1,
              accepts: [{
                network: 'bch',
                scheme: 'utxo',
                payTo: 'bitcoincash:qprecv',
                minAmountRequired: 1500
              }]
            }
          },
          config: { headers: {} }
        })
        .onSecondCall()
        .resolves({ data: 'ok' })

      withPaymentInterceptor(axiosInstance, signer)

      const [, errorHandler] = axiosInstance.interceptors.response.use.firstCall.args

      // Create v1 response format
      const error = {
        response: {
          status: 402,
          headers: {},
          data: {
            x402Version: 1,
            accepts: [{
              network: 'bch',
              scheme: 'utxo',
              payTo: 'bitcoincash:qprecv',
              minAmountRequired: 1500
            }]
          }
        },
        config: {
          headers: {}
        }
      }

      const response = await errorHandler(error)

      assert.deepEqual(response, { data: 'ok' })
      assert.isTrue(sendPaymentStub.calledOnce)
    })
  })
})
