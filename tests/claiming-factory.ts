import * as anchor from '@project-serum/anchor';
import * as serumCmn from "@project-serum/common";
import { TokenInstructions } from '@project-serum/serum';
import * as spl from "@solana/spl-token";
import * as assert from 'assert';

import { ClaimingFactory } from '../target/types/claiming_factory';

const TOKEN_PROGRAM_ID = TokenInstructions.TOKEN_PROGRAM_ID;

async function createMint(provider: anchor.Provider, authority?: anchor.web3.PublicKey) {
  if (authority === undefined) {
    authority = provider.wallet.publicKey;
  }
  const mint = await spl.Token.createMint(
    provider.connection,
    provider.wallet.payer,
    authority,
    null,
    6,
    TOKEN_PROGRAM_ID,
  );
  return mint;
}

describe('claiming-factory', () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ClaimingFactory as anchor.Program<ClaimingFactory>;

  const MERKLE_ROOT_TEST = Buffer.from("5b86ffd388e4e795ed1640ae6a0f710b1f26aba02be4cc54e8e23b4f030daaeb", 'hex');
  const MERKLE_PROOFS = [
    "0x26db859e72c5023fcaf9d5449801483163d7e406d27e7cc92413b95b2219e19a",
    "0x45c6e560172684cbc7df33b1ba0079afc39e4587e39240d08e0996c692d767af",
    "0xbac7804eeb44c280c0e3c5fb9cba2a75705c1b48f25ebefcfb90fa1c26b3c705",
    "0x0475c03faf773c403f1b6c6e672ec26c53a244a5b4c3d0fa2d67242266527e85",
    "0x158b73613a6895d5a8260fa597387cbfbef0e0738c4e24e85d1cf977d7e4442a",
    "0x250fe6c7b5a0d6a9d48ab387048758cbd2c00ceb4d765b1cc3edc80d9bb0e524"
  ];

  let mint: spl.Token;

  before(async () => {
    mint = await createMint(provider);
  });

  async function createDistributor() {
    const distributor = anchor.web3.Keypair.generate();

    const [vaultAuthority, vaultBump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.publicKey.toBytes()
      ],
      program.programId,
    );

    const vault = anchor.web3.Keypair.generate();
    const createTokenAccountInstrs = await serumCmn.createTokenAccountInstrs(
      provider,
      vault.publicKey,
      mint.publicKey,
      vaultAuthority
    );

    await program.rpc.initialize(
      {
        vaultBump,
        merkleRoot: MERKLE_ROOT_TEST,
      },
      {
        accounts: {
          distributor: distributor.publicKey,
          owner: provider.wallet.publicKey,
          vaultAuthority,
          vault: vault.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        instructions: createTokenAccountInstrs,
        signers: [vault, distributor],
      }
    );

    return distributor.publicKey;
  }

  context("admin add/remove", async function () {
    before(async function () {
      this.distributor = await createDistributor();
      this.user = anchor.web3.Keypair.generate();
      this.newAdmin = anchor.web3.Keypair.generate();
    });

    it('should not allow to add admin by user', async function () {
      await assert.rejects(
        async () => {
          await program.rpc.addAdmin(
            this.newAdmin.publicKey,
            {
              accounts: {
                distributor: this.distributor,
                owner: this.user.publicKey,
              },
              signers: [this.user]
            },
          )
        },
        (err) => {
          assert.equal(err.code, 305);
          return true;
        }
      );
    });

    it('should add admin by owner', async function () {
      await program.rpc.addAdmin(
        this.newAdmin.publicKey,
        {
          accounts: {
            distributor: this.distributor,
            owner: provider.wallet.publicKey,
          },
        },
      );

      const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
      assert.deepStrictEqual(distributorAccount.admins, [this.newAdmin.publicKey, null, null, null, null]);
    });

    it('should not allow to remove admin by user', async function () {
      await assert.rejects(
        async () => {
          await program.rpc.removeAdmin(
            this.newAdmin.publicKey,
            {
              accounts: {
                distributor: this.distributor,
                owner: this.user.publicKey,
              },
              signers: [this.user]
            },
          )
        },
        (err) => {
          assert.equal(err.code, 305);
          return true;
        }
      );
    });

    it('should remove admin by owner', async function () {
      await program.rpc.removeAdmin(
        this.newAdmin.publicKey,
        {
          accounts: {
            distributor: this.distributor,
            owner: provider.wallet.publicKey,
          },
        },
      );

      const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
      assert.deepStrictEqual(distributorAccount.admins, [null, null, null, null, null]);
    });
  });

  context('distributor', async function () {
    beforeEach(async function () {
      this.distributor = await createDistributor();
      this.user = anchor.web3.Keypair.generate();
      this.newAdmin = anchor.web3.Keypair.generate();
    });

    it('should have correct initial values', async function () {

    });
  });
});
