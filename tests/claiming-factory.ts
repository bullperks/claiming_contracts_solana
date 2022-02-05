import * as anchor from '@project-serum/anchor';
import * as serumCmn from "@project-serum/common";
import { TokenInstructions } from '@project-serum/serum';
import * as spl from "@solana/spl-token";
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as assert from 'assert';

import * as merkle from './merkle-tree';
import * as claiming from '../web3/claiming';

import * as ty from '../target/types/claiming_factory';

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

  const client = new claiming.Client(provider.wallet, claiming.LOCALNET);

  const user = anchor.web3.Keypair.generate();
  const userWallet = new anchor.Wallet(user);
  const userClient = new claiming.Client(userWallet, claiming.LOCALNET);

  const admin = anchor.web3.Keypair.generate();
  const adminWallet = new anchor.Wallet(admin);
  const adminClient = new claiming.Client(adminWallet, claiming.LOCALNET);

  const program = anchor.workspace.ClaimingFactory as anchor.Program<ty.ClaimingFactory>;

  let
    mint: spl.Token,
    config: anchor.web3.PublicKey,
    merkleData: merkle.MerkleData;

  async function generateMerkle() {
    const data = [];
    for (var i = 0; i < 42; i++) {
      const address = await serumCmn.createTokenAccount(provider, mint.publicKey, provider.wallet.publicKey);
      data.push({ address, amount: i });
    }
    return merkle.getMerkleProof(data);
  }

  before(async () => {
    mint = await createMint(provider);
    config = await client.createConfig();
    let tx = await provider.connection.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(tx);
    tx = await provider.connection.requestAirdrop(admin.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(tx);

    merkleData = await generateMerkle();
  });

  context("admin add/remove", async function () {
    beforeEach(async function () {
      anchor.setProvider(provider);
    });

    it('should not allow to add admin by user', async function () {
      await assert.rejects(
        async () => {
          await userClient.addAdmin(admin.publicKey);
        },
        (err) => {
          assert.equal(err.code, 6005);
          return true;
        }
      );
    });

    it('should add admin by owner', async function () {
      await client.addAdmin(admin.publicKey);

      const configAccount = await program.account.config.fetch(config);
      const [newAdmin] = configAccount.admins.filter((a) => a && a.equals(admin.publicKey));
      assert.ok(newAdmin);
    });

    it('should not allow to remove admin by user', async function () {
      await assert.rejects(
        async () => {
          await userClient.removeAdmin(admin.publicKey);
        },
        (err) => {
          assert.equal(err.code, 6005);
          return true;
        }
      );
    });

    it('should remove admin by owner', async function () {
      await client.removeAdmin(admin.publicKey);

      const configAccount = await program.account.config.fetch(config);
      const maybeNewAdmin = configAccount.admins.filter((a) => a && a.equals(admin.publicKey));
      assert.deepStrictEqual(maybeNewAdmin, []);
    });
  });

  context('create disributor', async function () {
    it("shouldn't allow deploy new distributor if not owner or admin", async function () {
      await assert.rejects(
        async () => {
          await userClient.createDistributor(mint.publicKey, merkleData.root);
        },
        (err) => {
          assert.equal(err.code, 6006);
          return true;
        }
      );
    });

    it("should allow to initialize new distributor by admin", async function () {
      await client.addAdmin(admin.publicKey);

      const distributor = await adminClient.createDistributor(mint.publicKey, merkleData.root);
      await program.account.merkleDistributor.fetch(distributor);
    });

    it("should allow to initialize new distributor by owner", async function () {
      const distributor = await client.createDistributor(mint.publicKey, merkleData.root);
      await program.account.merkleDistributor.fetch(distributor);
    });
  });

  context('distributor', async function () {
    beforeEach(async function () {
      this.distributor = await client.createDistributor(mint.publicKey, merkleData.root);
      this.distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);

      this.vault = this.distributorAccount.vault;
      mint.mintTo(this.vault, provider.wallet.publicKey, [], 1000);

      this.vaultAuthority = await anchor.web3.PublicKey.createProgramAddress(
        [
          this.distributor.toBytes(),
          [this.distributorAccount.vaultBump]
        ],
        program.programId
      );
    });

    it('should have correct initial values', async function () {
      assert.ok(this.distributorAccount.merkleIndex.eqn(0));
      assert.ok(Buffer.from(this.distributorAccount.merkleRoot).equals(merkleData.root));
    });

    context("withdraw tokens", async function () {
      it("shouldn't allow withdraw by user", async function () {
        const targetWallet = await serumCmn.createTokenAccount(userClient.provider, mint.publicKey, user.publicKey);

        await assert.rejects(
          async () => {
            await userClient.withdrawTokens(new anchor.BN(100), this.distributor, targetWallet);
          },
          (err) => {
            assert.equal(err.code, 6005);
            return true;
          }
        );
      });

      it("shouldn't allow withdraw by admin", async function () {
        const targetWallet = await serumCmn.createTokenAccount(adminClient.provider, mint.publicKey, admin.publicKey);

        await assert.rejects(
          async () => {
            await adminClient.withdrawTokens(new anchor.BN(100), this.distributor, targetWallet);
          },
          (err) => {
            assert.equal(err.code, 6005);
            return true;
          }
        );
      });

      it("should withdraw token by owner", async function () {
        const targetWallet = await serumCmn.createTokenAccount(provider, mint.publicKey, user.publicKey);
        await client.withdrawTokens(new anchor.BN(100), this.distributor, targetWallet);

        const targetWalletAccount = await serumCmn.getTokenAccount(provider, targetWallet);
        assert.ok(targetWalletAccount.amount.eqn(100));
      });
    });

    context("update root", async function () {
      const UPDATED_ROOT = Buffer.from("5b86ffd388e4e795ed1640ae6a0f710b1f26aba02befcc54e8e23b4f030daaeb", 'hex').toJSON().data;

      it("shouldn't allow update by user", async function () {
        await assert.rejects(
          async () => {
            await userClient.updateRoot(this.distributor, UPDATED_ROOT, false);
          },
          (err) => {
            assert.equal(err.code, 6006);
            return true;
          }
        );
      });

      it("should allow update by admin", async function () {
        await client.addAdmin(admin.publicKey);
        await adminClient.updateRoot(this.distributor, UPDATED_ROOT, false);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.deepStrictEqual(distributorAccount.merkleRoot, UPDATED_ROOT);
      });

      it("should allow update by owner", async function () {
        await client.updateRoot(this.distributor, UPDATED_ROOT, false);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.deepStrictEqual(distributorAccount.merkleRoot, UPDATED_ROOT);
      });
    });

    context("update root and unpause", async function () {
      it("should unpause if it's paused by admin", async function () {
        await client.pause(this.distributor);
        await client.addAdmin(admin.publicKey);
        await adminClient.updateRoot(this.distributor, merkleData.root, true);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("should unpause if it paused by owner", async function () {
        await client.pause(this.distributor);
        await client.updateRoot(this.distributor, merkleData.root, true);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });
    });

    context("pause", async function () {
      it("shouldn't allow to pause the program by user", async function () {
        await assert.rejects(
          async () => {
            await userClient.pause(this.distributor);
          },
          (err) => {
            assert.equal(err.code, 6006);
            return true;
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("shouldn't allow to pause the program if it already paused", async function () {
        await client.pause(this.distributor);
        let balanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);

        await assert.rejects(
          async () => {
            await client.pause(this.distributor);
          },
          (err) => {
            assert.equal(err.code, 6007);
            return true;
          }
        );

        let balanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);
        assert.equal(balanceBefore, balanceAfter);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, true);
      });

      it("should allow to pause the program by admin", async function () {
        await client.addAdmin(admin.publicKey);
        await adminClient.pause(this.distributor);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, true);
      });

      it("should allow to pause the program by owner", async function () {
        await client.pause(this.distributor);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, true);
      });
    });

    context("unpause", async function () {
      it("shouldn't allow to unpause the program by user", async function () {
        await assert.rejects(
          async () => {
            await userClient.unpause(this.distributor);
          },
          (err) => {
            assert.ok(err.code, 306);
            return true;
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("shouldn't allow to unpause the program if it already unpaused", async function () {
        let balanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);

        await assert.rejects(
          async () => {
            await client.unpause(this.distributor);
          },
          (err) => {
            assert.equal(err.code, 6007);
            return true;
          }
        );

        let balanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);
        assert.equal(balanceBefore, balanceAfter);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("should allow to unpause the program by admin", async function () {
        await client.pause(this.distributor);
        await client.addAdmin(admin.publicKey);
        await adminClient.unpause(this.distributor);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("should allow to unpause the program by owner", async function () {
        await client.pause(this.distributor);
        await client.unpause(this.distributor);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });
    });

    context("check if claimed", async function () {
      it("should return false if reward has not been claimed", async function () {
        assert.equal(await client.isClaimed(this.distributor, new anchor.BN(0)), false);
      });

      it("should return true if reward has been claimed", async function () {
        const bitmap = await client.initBitmap(this.distributor);
        const merkleElement = merkleData.proofs[30];

        await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);

        assert.ok(await client.isClaimed(this.distributor, merkleElement.index));
      });
    });

    context("claim", async function () {
      beforeEach(async function () {
        this.bitmap = await client.initBitmap(this.distributor);
      })

      it("should claim correctly", async function () {
        const merkleElement = merkleData.proofs[29];

        await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);

        const targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(merkleElement.amount));
      });

      it("shouldn't allow to claim token if claiming has been paused", async function () {
        await client.pause(this.distributor);

        const merkleElement = merkleData.proofs[30];

        await assert.rejects(
          async () => {
            await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);
          },
          (err) => {
            assert.equal(err.code, 6008);
            return true;
          }
        )
      });

      it("should fail if merkle proof is not correct", async function () {
        const merkleElement = merkleData.proofs[30];

        await assert.rejects(
          async () => {
            await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleData.proofs[29].proofs);
          },
          (err) => {
            assert.equal(err.code, 6003);
            return true;
          }
        )
      });

      it("shouldn't claim if reward has been claimed", async function () {
        const merkleElement = merkleData.proofs[30];

        await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);

        await assert.rejects(
          async () => {
            await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);
          },
          (err) => {
            assert.equal(err.code, 6004);
            return true;
          }
        );
      });

      it("should claim correctly twice, if root has been changed", async function () {
        let merkleElement = merkleData.proofs[25];

        await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);

        const firstAmount = merkleElement.amount;
        let targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(firstAmount));

        let data = [];
        for (const elem of merkleData.proofs) {
          data.push({ address: elem.address, amount: elem.amount.toNumber() * 2 });
        }
        let updatedMerkleData = merkle.getMerkleProof(data);

        await client.updateRoot(this.distributor, updatedMerkleData.root, true);
        await client.initBitmap(this.distributor);

        merkleElement = updatedMerkleData.proofs[25];

        await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);

        targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(merkleElement.amount.add(firstAmount)));
      });

      it("should claim correctly twice, if root has been changed to the same", async function () {
        let merkleElement = merkleData.proofs[24];

        await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);

        const firstAmount = merkleElement.amount;
        let targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(firstAmount));

        let data = [];
        for (const elem of merkleData.proofs) {
          data.push({ address: elem.address, amount: elem.amount.toNumber() * 2 });
        }
        let updatedMerkleData = merkle.getMerkleProof(data);

        await client.updateRoot(this.distributor, updatedMerkleData.root, true);
        await client.initBitmap(this.distributor);

        merkleElement = updatedMerkleData.proofs[24];

        await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);

        const secondAmount = merkleElement.amount.add(firstAmount);
        targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(secondAmount));

        await client.updateRoot(this.distributor, updatedMerkleData.root, true);
        await client.initBitmap(this.distributor);

        await client.claim(this.distributor, merkleElement.address, merkleElement.index, merkleElement.amount, merkleElement.proofs);

        targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(merkleElement.amount.add(secondAmount)));
      });
    });
  });
});
