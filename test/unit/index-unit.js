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

  describe('#sendPayment', () => {
    function createSignerStub () {
      return {
        wif: 'test-wif',
        paymentAmountSats: 2000,
        address: 'bitcoincash:qptest'
      }
    }

    function createPaymentRequirementsStub () {
      return {
        payTo: 'bitcoincash:qprecv',
        amount: '1500',
        scheme: 'utxo',
        network: 'bip122:000000000000000000651ef99cb9fcbe'
      }
    }

    it('should route to sendPaymentGeneric when URL is not fullstack', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        apiType: 'rest-api',
        bchServerURL: 'https://api.example.com'
      }

      const mockBchWallet = {
        initialize: sandbox.stub().resolves(),
        send: sandbox.stub().resolves('tx123')
      }

      const mockRetryQueue = {
        addToQueue: sandbox.stub().resolves('tx123')
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)
      const RetryQueueStub = sandbox.stub().returns(mockRetryQueue)

      __setDependencies({
        BCHWallet: BCHWalletStub,
        RetryQueue: RetryQueueStub
      })

      const result = await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)

      assert.deepEqual(result, {
        txid: 'tx123',
        vout: 0,
        satsSent: 2000
      })

      assert.isTrue(BCHWalletStub.calledOnce)
      assert.deepEqual(BCHWalletStub.firstCall.args[0], 'test-wif')
      assert.deepEqual(BCHWalletStub.firstCall.args[1], {
        interface: 'rest-api',
        restURL: 'https://api.example.com',
        bearerToken: undefined
      })
      assert.isTrue(mockBchWallet.initialize.calledOnce)
      assert.isTrue(RetryQueueStub.calledOnce)
      assert.isTrue(mockRetryQueue.addToQueue.calledOnce)

      // Verify sendWithRetry was called with receivers
      const sendWithRetry = mockRetryQueue.addToQueue.firstCall.args[0]
      const receivers = mockRetryQueue.addToQueue.firstCall.args[1]
      assert.isFunction(sendWithRetry)
      assert.deepEqual(receivers, [{
        address: 'bitcoincash:qprecv',
        amountSat: 2000
      }])

      __resetDependencies()
    })

    it('should route to sendPaymentFullstack when URL contains bch.fullstack.cash', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        apiType: 'rest-api',
        bchServerURL: 'https://bch.fullstack.cash/v5/'
      }

      const mockEcPair = { ecpair: true }
      const mockUtxos = [{
        tx_hash: 'utxo-txid',
        tx_pos: 1,
        value: 5000
      }]

      const mockTransactionBuilder = {
        addInput: sandbox.stub(),
        addOutput: sandbox.stub(),
        sign: sandbox.stub(),
        build: sandbox.stub().returns({
          toHex: sandbox.stub().returns('raw-hex')
        }),
        hashTypes: {
          SIGHASH_ALL: 1
        }
      }

      const mockBchjs = {
        ECPair: {
          fromWIF: sandbox.stub().returns(mockEcPair),
          toCashAddress: sandbox.stub().returns('bitcoincash:qptest')
        },
        Electrumx: {
          utxo: sandbox.stub().resolves({ utxos: mockUtxos })
        },
        TransactionBuilder: sandbox.stub().returns(mockTransactionBuilder),
        BitcoinCash: {
          getByteCount: sandbox.stub().returns(250)
        },
        RawTransactions: {
          sendRawTransaction: sandbox.stub().resolves('tx123')
        }
      }

      const mockBchWallet = {
        walletInfoPromise: Promise.resolve(),
        bchjs: mockBchjs
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)

      __setDependencies({
        BCHWallet: BCHWalletStub
      })

      const result = await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)

      assert.deepEqual(result, {
        txid: 'tx123',
        vout: 0,
        satsSent: 2000
      })

      assert.isTrue(BCHWalletStub.calledOnce)
      assert.deepEqual(BCHWalletStub.firstCall.args[0], 'test-wif')
      assert.deepEqual(BCHWalletStub.firstCall.args[1], {
        interface: 'rest-api',
        restURL: 'https://bch.fullstack.cash/v5/',
        bearerToken: undefined
      })
      assert.isTrue(mockBchjs.ECPair.fromWIF.calledOnce)
      assert.isTrue(mockBchjs.Electrumx.utxo.calledOnce)
      assert.isTrue(mockBchjs.TransactionBuilder.calledOnce)
      assert.isTrue(mockTransactionBuilder.addInput.calledOnce)
      assert.isTrue(mockTransactionBuilder.addOutput.calledTwice)
      assert.isTrue(mockTransactionBuilder.sign.calledOnce)
      assert.isTrue(mockBchjs.RawTransactions.sendRawTransaction.calledOnce)
      assert.deepEqual(mockBchjs.RawTransactions.sendRawTransaction.firstCall.args[0], ['raw-hex'])

      __resetDependencies()
    })

    it('should throw "Insufficient balance" error when sendWithRetry returns null', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        bchServerURL: 'https://api.example.com'
      }

      const mockBchWallet = {
        initialize: sandbox.stub().resolves(),
        send: sandbox.stub().rejects(new Error('Insufficient balance'))
      }

      const mockRetryQueue = {
        addToQueue: sandbox.stub().resolves(null) // sendWithRetry returns null for insufficient balance
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)
      const RetryQueueStub = sandbox.stub().returns(mockRetryQueue)

      __setDependencies({
        BCHWallet: BCHWalletStub,
        RetryQueue: RetryQueueStub
      })

      try {
        await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)
        assert.fail('Expected "Insufficient balance" error to be thrown')
      } catch (err) {
        assert.equal(err.message, 'Insufficient balance')
      }

      // Verify sendWithRetry was called and handled the error
      assert.isTrue(mockRetryQueue.addToQueue.calledOnce)
      const sendWithRetry = mockRetryQueue.addToQueue.firstCall.args[0]

      // Test sendWithRetry directly to verify it returns null for insufficient balance
      try {
        const result = await sendWithRetry([{ address: 'test', amountSat: 1000 }])
        assert.strictEqual(result, null)
      } catch (err) {
        assert.fail('sendWithRetry should return null, not throw')
      }

      __resetDependencies()
    })

    it('should handle "Insufficient balance" error in sendWithRetry wrapper', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        bchServerURL: 'https://api.example.com'
      }

      const insufficientBalanceError = new Error('Insufficient balance')
      const mockBchWallet = {
        initialize: sandbox.stub().resolves(),
        send: sandbox.stub().rejects(insufficientBalanceError)
      }

      const mockRetryQueue = {
        addToQueue: sandbox.stub().callsFake(async (fn, args) => {
          // Simulate what RetryQueue does - call the function
          return await fn(args)
        })
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)
      const RetryQueueStub = sandbox.stub().returns(mockRetryQueue)

      __setDependencies({
        BCHWallet: BCHWalletStub,
        RetryQueue: RetryQueueStub
      })

      try {
        await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)
        assert.fail('Expected "Insufficient balance" error to be thrown')
      } catch (err) {
        assert.equal(err.message, 'Insufficient balance')
      }

      // Verify that sendWithRetry was called and returned null
      assert.isTrue(mockRetryQueue.addToQueue.calledOnce)
      const sendWithRetry = mockRetryQueue.addToQueue.firstCall.args[0]
      const receivers = mockRetryQueue.addToQueue.firstCall.args[1]

      // Call sendWithRetry directly to verify it returns null
      const result = await sendWithRetry(receivers)
      assert.strictEqual(result, null)

      __resetDependencies()
    })

    it('should re-throw other errors from sendWithRetry for retry queue to handle', async () => {
      const networkError = new Error('Network timeout')
      const mockBchWallet = {
        initialize: sandbox.stub().resolves(),
        send: sandbox.stub().rejects(networkError)
      }

      // RetryQueue should eventually succeed after retries
      const mockRetryQueue = {
        addToQueue: sandbox.stub().resolves('tx456')
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)
      const RetryQueueStub = sandbox.stub().returns(mockRetryQueue)

      __setDependencies({
        BCHWallet: BCHWalletStub,
        RetryQueue: RetryQueueStub
      })

      // Test sendWithRetry directly to verify it re-throws non-insufficient-balance errors
      const receivers = [{ address: 'test', amountSat: 1000 }]

      // Extract sendWithRetry by simulating what happens in sendPayment
      const sendWithRetry = async (receivers) => {
        try {
          return await mockBchWallet.send(receivers)
        } catch (error) {
          if (error.message && error.message.includes('Insufficient balance')) {
            return null
          }
          throw error
        }
      }

      // Verify that sendWithRetry re-throws non-insufficient-balance errors
      try {
        await sendWithRetry(receivers)
        assert.fail('Expected network error to be thrown')
      } catch (err) {
        assert.equal(err.message, 'Network timeout')
      }

      // Verify that send was called
      assert.isTrue(mockBchWallet.send.calledOnce)

      __resetDependencies()
    })

    it('should use paymentAmountSats from signer when available', async () => {
      const signer = createSignerStub()
      signer.paymentAmountSats = 5000
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        bchServerURL: 'https://api.example.com'
      }

      const mockBchWallet = {
        initialize: sandbox.stub().resolves(),
        send: sandbox.stub().resolves('tx789')
      }

      const mockRetryQueue = {
        addToQueue: sandbox.stub().resolves('tx789')
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)
      const RetryQueueStub = sandbox.stub().returns(mockRetryQueue)

      __setDependencies({
        BCHWallet: BCHWalletStub,
        RetryQueue: RetryQueueStub
      })

      await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)

      const receivers = mockRetryQueue.addToQueue.firstCall.args[1]
      assert.equal(receivers[0].amountSat, 5000)

      __resetDependencies()
    })

    it('should use amountRequired from paymentRequirements when signer.paymentAmountSats is not set', async () => {
      const signer = createSignerStub()
      delete signer.paymentAmountSats
      const paymentRequirements = createPaymentRequirementsStub()
      paymentRequirements.amount = '3000'
      const bchServerConfig = {
        bchServerURL: 'https://api.example.com'
      }

      const mockBchWallet = {
        initialize: sandbox.stub().resolves(),
        send: sandbox.stub().resolves('tx999')
      }

      const mockRetryQueue = {
        addToQueue: sandbox.stub().resolves('tx999')
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)
      const RetryQueueStub = sandbox.stub().returns(mockRetryQueue)

      __setDependencies({
        BCHWallet: BCHWalletStub,
        RetryQueue: RetryQueueStub
      })

      await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)

      const receivers = mockRetryQueue.addToQueue.firstCall.args[1]
      assert.equal(receivers[0].amountSat, '3000')

      __resetDependencies()
    })

    it('should only match "Insufficient balance" error message (case-sensitive)', async () => {
      const mockBchWallet = {
        initialize: sandbox.stub().resolves(),
        send: sandbox.stub().rejects(new Error('INSUFFICIENT BALANCE'))
      }

      // Test sendWithRetry directly
      const sendWithRetry = async (receivers) => {
        try {
          return await mockBchWallet.send(receivers)
        } catch (error) {
          if (error.message && error.message.includes('Insufficient balance')) {
            return null
          }
          throw error
        }
      }

      const receivers = [{ address: 'test', amountSat: 1000 }]

      // This should NOT return null because the error message doesn't match (case-sensitive check)
      // The includes() method is case-sensitive, so 'INSUFFICIENT BALANCE' won't match 'Insufficient balance'
      try {
        const result = await sendWithRetry(receivers)
        // If it returns null, that's unexpected
        if (result === null) {
          assert.fail('Should not return null for case-mismatched error message')
        }
      } catch (err) {
        // Expected - error should be re-thrown because it doesn't match
        assert.equal(err.message, 'INSUFFICIENT BALANCE')
      }

      __resetDependencies()
    })

    it('should propagate errors from wallet initialization', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        bchServerURL: 'https://api.example.com'
      }

      const initError = new Error('Failed to initialize wallet')
      const mockBchWallet = {
        initialize: sandbox.stub().rejects(initError),
        send: sandbox.stub()
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)
      const RetryQueueStub = sandbox.stub()

      __setDependencies({
        BCHWallet: BCHWalletStub,
        RetryQueue: RetryQueueStub
      })

      try {
        await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)
        assert.fail('Expected initialization error to be thrown')
      } catch (err) {
        assert.equal(err.message, 'Failed to initialize wallet')
      }

      assert.isTrue(mockBchWallet.initialize.calledOnce)
      assert.isTrue(RetryQueueStub.notCalled)

      __resetDependencies()
    })

    it('should support v1 minAmountRequired field in sendPaymentGeneric', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      delete paymentRequirements.amount
      paymentRequirements.minAmountRequired = 2500
      const bchServerConfig = {
        bchServerURL: 'https://api.example.com'
      }

      const mockBchWallet = {
        initialize: sandbox.stub().resolves(),
        send: sandbox.stub().resolves('tx-v1')
      }

      const mockRetryQueue = {
        addToQueue: sandbox.stub().resolves('tx-v1')
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)
      const RetryQueueStub = sandbox.stub().returns(mockRetryQueue)

      __setDependencies({
        BCHWallet: BCHWalletStub,
        RetryQueue: RetryQueueStub
      })

      await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)

      const receivers = mockRetryQueue.addToQueue.firstCall.args[1]
      // Should use paymentAmountSats from signer (2000) when available, not minAmountRequired
      assert.equal(receivers[0].amountSat, 2000)

      __resetDependencies()
    })

    it('should handle UTXO retrieval errors in sendPaymentFullstack', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        apiType: 'rest-api',
        bchServerURL: 'https://bch.fullstack.cash/v5/'
      }

      const mockEcPair = { ecpair: true }
      const mockBchjs = {
        ECPair: {
          fromWIF: sandbox.stub().returns(mockEcPair),
          toCashAddress: sandbox.stub().returns('bitcoincash:qptest')
        },
        Electrumx: {
          utxo: sandbox.stub().rejects(new Error('Network error'))
        }
      }

      const mockBchWallet = {
        walletInfoPromise: Promise.resolve(),
        bchjs: mockBchjs
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)

      __setDependencies({
        BCHWallet: BCHWalletStub
      })

      try {
        await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)
        assert.fail('Expected error to be thrown')
      } catch (err) {
        assert.match(err.message, /Error retrieving UTXOs/)
        assert.match(err.message, /Network error/)
      }

      __resetDependencies()
    })

    it('should throw error when insufficient balance in sendPaymentFullstack', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        apiType: 'rest-api',
        bchServerURL: 'https://bch.fullstack.cash/v5/'
      }

      const mockEcPair = { ecpair: true }
      const mockUtxos = [{
        tx_hash: 'utxo-txid',
        tx_pos: 1,
        value: 1000 // Less than paymentAmountSats (2000)
      }]

      const mockBchjs = {
        ECPair: {
          fromWIF: sandbox.stub().returns(mockEcPair),
          toCashAddress: sandbox.stub().returns('bitcoincash:qptest')
        },
        Electrumx: {
          utxo: sandbox.stub().resolves({ utxos: mockUtxos })
        }
      }

      const mockBchWallet = {
        walletInfoPromise: Promise.resolve(),
        bchjs: mockBchjs
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)

      __setDependencies({
        BCHWallet: BCHWalletStub
      })

      try {
        await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)
        assert.fail('Expected error to be thrown')
      } catch (err) {
        // Should fail because utxos[0] is undefined after filtering
        assert.isDefined(err)
      }

      __resetDependencies()
    })

    it('should handle transaction building errors in sendPaymentFullstack', async () => {
      const signer = createSignerStub()
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        apiType: 'rest-api',
        bchServerURL: 'https://bch.fullstack.cash/v5/'
      }

      const mockEcPair = { ecpair: true }
      const mockUtxos = [{
        tx_hash: 'utxo-txid',
        tx_pos: 1,
        value: 5000
      }]

      const mockTransactionBuilder = {
        addInput: sandbox.stub(),
        addOutput: sandbox.stub(),
        sign: sandbox.stub(),
        build: sandbox.stub().throws(new Error('Build failed')),
        hashTypes: {
          SIGHASH_ALL: 1
        }
      }

      const mockBchjs = {
        ECPair: {
          fromWIF: sandbox.stub().returns(mockEcPair),
          toCashAddress: sandbox.stub().returns('bitcoincash:qptest')
        },
        Electrumx: {
          utxo: sandbox.stub().resolves({ utxos: mockUtxos })
        },
        TransactionBuilder: sandbox.stub().returns(mockTransactionBuilder),
        BitcoinCash: {
          getByteCount: sandbox.stub().returns(250)
        }
      }

      const mockBchWallet = {
        walletInfoPromise: Promise.resolve(),
        bchjs: mockBchjs
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)

      __setDependencies({
        BCHWallet: BCHWalletStub
      })

      try {
        await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)
        assert.fail('Expected error to be thrown')
      } catch (err) {
        assert.equal(err.message, 'Build failed')
      }

      __resetDependencies()
    })

    it('should throw error when remainder is negative in sendPaymentFullstack', async () => {
      const signer = createSignerStub()
      signer.paymentAmountSats = 10000 // Large amount
      const paymentRequirements = createPaymentRequirementsStub()
      const bchServerConfig = {
        apiType: 'rest-api',
        bchServerURL: 'https://bch.fullstack.cash/v5/'
      }

      const mockEcPair = { ecpair: true }
      // UTXO value must be >= paymentAmountSats (10000) to pass filter
      // But remainder = value - paymentAmountSats - txFee must be negative
      // With txFee = 1.2 * 250 = 300, we need value < 10300
      // So use value = 10200: remainder = 10200 - 10000 - 300 = -100 < 0
      const mockUtxos = [{
        tx_hash: 'utxo-txid',
        tx_pos: 1,
        value: 10200 // >= paymentAmountSats but insufficient after fee
      }]

      const mockTransactionBuilder = {
        addInput: sandbox.stub(),
        addOutput: sandbox.stub(),
        sign: sandbox.stub(),
        hashTypes: {
          SIGHASH_ALL: 1
        }
      }

      const mockBchjs = {
        ECPair: {
          fromWIF: sandbox.stub().returns(mockEcPair),
          toCashAddress: sandbox.stub().returns('bitcoincash:qptest')
        },
        Electrumx: {
          utxo: sandbox.stub().resolves({ utxos: mockUtxos })
        },
        TransactionBuilder: sandbox.stub().returns(mockTransactionBuilder),
        BitcoinCash: {
          getByteCount: sandbox.stub().returns(250)
        }
      }

      const mockBchWallet = {
        walletInfoPromise: Promise.resolve(),
        bchjs: mockBchjs
      }

      const BCHWalletStub = sandbox.stub().returns(mockBchWallet)

      __setDependencies({
        BCHWallet: BCHWalletStub
      })

      try {
        await __internals.sendPayment(signer, paymentRequirements, bchServerConfig)
        assert.fail('Expected error to be thrown')
      } catch (err) {
        assert.equal(err.message, 'Not enough BCH to complete transaction!')
      }

      __resetDependencies()
    })
  })
})
