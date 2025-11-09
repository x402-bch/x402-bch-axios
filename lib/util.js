/*
  An example of a typical utility library. Things to notice:
  - This library is exported as a Class.
  - External dependencies are embedded into the class 'this' object: this.bchjs
*/

'use strict'

// Global npm libraries
import BCHJS from '@psf/bch-js'

class UtilLib {
  constructor () {
    // Encapsulate dependencies
    this.bchjs = new BCHJS()

    // Bind 'this' object to all class methods
    this.getBchData = this.getBchData.bind(this)
  }

  async getBchData (addr) {
    try {
      // Validate Input
      if (typeof addr !== 'string') throw new Error('Address must be a string')

      const balance = await this.bchjs.Electrumx.balance(addr)

      const utxos = await this.bchjs.Electrumx.utxo(addr)

      const bchData = {
        balance: balance.balance,
        utxos: utxos.utxos
      }
      // console.log(`bchData: ${JSON.stringify(bchData, null, 2)}`)

      return bchData
    } catch (err) {
      // Optional log to indicate the source of the error. This would normally
      // be written with a logging app like Winston.
      console.log('Error in util.js/getBalance()')
      throw err
    }
  }
}

export default UtilLib
