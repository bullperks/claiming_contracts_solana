import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';

import { ClaimingFactory } from '../target/types/claiming_factory';

describe('claiming-factory', () => {

  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.Provider.env());

  const program = anchor.workspace.ClaimingFactory as Program<ClaimingFactory>;

  it('Is initialized!', async () => {
    // Add your test here.
    const tx = await program.rpc.initialize({});
    console.log("Your transaction signature", tx);
  });
});
