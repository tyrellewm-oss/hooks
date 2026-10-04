// Ticket 8.3 test helper: launch() needs a launch key that equals the chain's launch authority. Tests that exercise
// other launch() checks with fakes call launchCall(): it passes TEST_LAUNCH_KEY and, when the test gives
// o.authorities, sets that key as the on-chain launch authority unless the test sets its own. In-memory key only.
import { Keypair } from '@solana/web3.js';
import { Launchpad } from '../sdk/launch.js';
export const TEST_LAUNCH_KEY = Keypair.generate();
export function launchCall(lp: any, deployer: Keypair, o: any, launchKey: Keypair = TEST_LAUNCH_KEY) {
  const authorities = o?.authorities ? { launchAuthority: TEST_LAUNCH_KEY.publicKey.toBase58(), ...o.authorities } : o?.authorities;
  return Launchpad.prototype.launch.call(lp, deployer, { ...o, authorities }, launchKey);
}
