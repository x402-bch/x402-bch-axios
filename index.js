/*
  An npm JavaScript library for front end web apps. Implements a minimal
  Bitcoin Cash wallet.
*/

/* eslint-disable no-async-promise-executor */

// Global npm libraries
import BCHJS from '@psf/bch-js'

// Local libraries
import Util from './lib/util.js'
const util = new Util()

class BoilerplateLib {
  constructor () {
    // Encapsulate dependencies
    this.bchjs = new BCHJS()
    this.util = util
  }
}

export default BoilerplateLib
