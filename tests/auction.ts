import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { PublicKey } from "@solana/web3.js";
import { Auction } from "../target/types/auction";
import { expect } from "chai"
const { SystemProgram } = anchor.web3;

describe("auction", () => {
  const provider = anchor.getProvider();
  anchor.setProvider(provider);

  const program = anchor.workspace.Auction as Program<Auction>;
  const initialFunds = 10000000000;

  let treasury: PublicKey = null;
  let state: PublicKey = null;

  // The Accounts to create.
  const initializer = anchor.web3.Keypair.generate();
  const thief = anchor.web3.Keypair.generate();

  const bidders = [
    { account: anchor.web3.Keypair.generate(), amount: 1.0 },
    { account: anchor.web3.Keypair.generate(), amount: 1.2 },
    { account: anchor.web3.Keypair.generate(), amount: 1.3 },
  ];

  const failRefundCases = [
    { title: "Not bidder claims refund - should fail", account: thief, errorCode: "AccountNotInitialized" },
    { title: "Loser claims refund for 2nd time - should fail", account: bidders[0].account, errorCode: "AccountNotInitialized" },
  ];

  before(async () => {
    await fundAccount(provider, initializer.publicKey, initialFunds);
    await fundAccount(provider, thief.publicKey, initialFunds);

    for (let bidder of bidders) {
      await fundAccount(provider, bidder.account.publicKey, initialFunds);
    }

    // Get the PDA that is assigned to treasury account.
    const [_state_pda, _state_nonce] = await PublicKey.findProgramAddress(
      [Buffer.from("state"), initializer.publicKey.toBytes()],
      program.programId
    );

    state = _state_pda;

    const [_pda, _nonce] = await PublicKey.findProgramAddress(
      [Buffer.from("treasury"), state.toBytes()],
      program.programId
    );

    treasury = _pda;

  })


  it("Is initialized!", async () => {
    const auctionDurationInSecs = new anchor.BN(3);

    await program.methods
      .initialize(auctionDurationInSecs)
      .accounts({
        state: state,
        initializer: initializer.publicKey,
        treasury: treasury,
        systemProgram: SystemProgram.programId,
      })
      .signers([initializer])
      .rpc();

    const auction = await program.account.state.fetch(state);

    const currentDeadline = Number(auction.deadline);
    // console.log("Auction Initialized!\nDeadline: ", currentDeadline);

    expect(currentDeadline).greaterThanOrEqual((new Date()).getTime() / 1000 + Number(auctionDurationInSecs) - 5);
  });


  for (let bidder of bidders) {
    let treasuryBalance: number;
    it("Place a bid", async () => {
      treasuryBalance = await provider.connection.getBalance(treasury);
      // Get the PDA that is assigned to user bid.
      const [userBidPda, _nonce] = await PublicKey.findProgramAddress(
        [Buffer.from("user-bid"), bidder.account.publicKey.toBytes(), state.toBytes()],
        program.programId
      );

      await program.methods
        .bid(bidder.amount)
        .accounts({
          state: state,
          user: bidder.account.publicKey,
          treasury: treasury,
          userBid: userBidPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([bidder.account])
        .rpc();

      const auction = await program.account.state.fetch(state);

      const highestBidNum = Number(auction.highestBidAmount);
      // console.log("Bid placed!\nHighest Bid: ", highestBidNum);

      const updatedTreasuryBalance = await provider.connection.getBalance(treasury);

      // Highest bid number is in lamports
      expect(highestBidNum).equal(bidder.amount * 10 ** 9);
      expect(auction.highestBidderAccount.toString()).equal(bidder.account.publicKey.toString());
      expect(auction.highestBidderAccount.toString()).equal(bidder.account.publicKey.toString());
      expect(updatedTreasuryBalance).equal(treasuryBalance + bidder.amount * 10 ** 9);
    });
  }

  it("End auction before deadline - should fail", async () => {
    const treasuryBalance = await provider.connection.getBalance(treasury);
    const auctionState = await program.account.state.fetch(state);
    // Get the PDA that is assigned to user bid.
    const [userBidPda, _nonce] = await PublicKey.findProgramAddress(
      [Buffer.from("user-bid"), auctionState.highestBidderAccount.toBytes(), state.toBytes()],
      program.programId
    );

    try {
      await program.methods
        .endAuction()
        .accounts({
          state: state,
          initializer: initializer.publicKey,
          treasury: treasury,
          userBid: userBidPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([initializer])
        .rpc();
      throw new Error("Should have failed!");
    } catch (error) {
      expect(error.error.errorCode.code).equal("StillActive");
    }

    const updatedTreasuryBalance = await provider.connection.getBalance(treasury)
    const auction = await program.account.state.fetch(state);

    expect(auction.sellerPayed).equal(false);
    expect(updatedTreasuryBalance).equal(treasuryBalance);
  });

  it("Not seller claims prize - should fail", async () => {
    const treasuryBalance = await provider.connection.getBalance(treasury);
    const auctionState = await program.account.state.fetch(state);
    // Get the PDA that is assigned to user bid.
    const [userBidPda, _nonce] = await PublicKey.findProgramAddress(
      [Buffer.from("user-bid"), auctionState.highestBidderAccount.toBytes(), state.toBytes()],
      program.programId
    );

    // wait 5secs for auction to finish
    await delay(5000);

    try {
      await program.methods
        .endAuction()
        .accounts({
          state: state,
          initializer: thief.publicKey,
          treasury: treasury,
          userBid: userBidPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([thief])
        .rpc();
      throw new Error("Should have failed!");
    } catch (error) {
      expect(error.error.errorCode.code).equal("ConstraintHasOne");
    }

    const updatedTreasuryBalance = await provider.connection.getBalance(treasury)
    const auction = await program.account.state.fetch(state);

    expect(auction.sellerPayed).equal(false);
    expect(updatedTreasuryBalance).equal(treasuryBalance);
  });

  it("End auction", async () => {
    const treasuryBalance = await provider.connection.getBalance(treasury);
    const sellerBalance = await provider.connection.getBalance(initializer.publicKey);

    const auctionState = await program.account.state.fetch(state);
    // Get the PDA that is assigned to user bid.
    const [userBidPda, _nonce] = await PublicKey.findProgramAddress(
      [Buffer.from("user-bid"), auctionState.highestBidderAccount.toBytes(), state.toBytes()],
      program.programId
    );

    await program.methods
      .endAuction()
      .accounts({
        state: state,
        initializer: initializer.publicKey,
        treasury: treasury,
        userBid: userBidPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([initializer])
      .rpc();

    const auction = await program.account.state.fetch(state);

    // console.log("Bid ended!");

    const updatedTreasuryBalance = await provider.connection.getBalance(treasury);
    const updatedSellerBalance = await provider.connection.getBalance(initializer.publicKey);

    // Highest bid number is in lamports
    expect(auction.sellerPayed).equal(true);
    expect(updatedTreasuryBalance).equal(treasuryBalance - Number(auctionState.highestBidAmount));
    expect(updatedSellerBalance).equal(sellerBalance + Number(auctionState.highestBidAmount));
  });


  it("Loser claims refund", async () => {
    const loser = bidders[0];
    const treasuryBalance = await provider.connection.getBalance(treasury);

    const [userBidPda, _nonce] = await PublicKey.findProgramAddress(
      [Buffer.from("user-bid"), loser.account.publicKey.toBytes(), state.toBytes()],
      program.programId
    );

    await program.methods
      .refund()
      .accounts({
        state: state,
        treasury: treasury,
        user: loser.account.publicKey,
        userBid: userBidPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([loser.account])
      .rpc();

    const updatedTreasuryBalance = await provider.connection.getBalance(treasury);
    const updatedLoserBalance = await provider.connection.getBalance(loser.account.publicKey);

    expect(updatedTreasuryBalance).equal(treasuryBalance - loser.amount * 10 ** 9);
    expect(updatedLoserBalance).equal(initialFunds);
  });


  it("Winner claims refund | should only get the rent payed for user_bid PDA", async () => {
    const winner = bidders[2];

    const [userBidPda, _nonce] = await PublicKey.findProgramAddress(
      [Buffer.from("user-bid"), winner.account.publicKey.toBytes(), state.toBytes()],
      program.programId
    );

    await program.methods
      .refund()
      .accounts({
        state: state,
        treasury: treasury,
        user: winner.account.publicKey,
        userBid: userBidPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([winner.account])
      .rpc();

    const updatedWinnerBalance = await provider.connection.getBalance(winner.account.publicKey);
    expect(updatedWinnerBalance).equal(initialFunds - winner.amount * 10 ** 9);
  });


  for (let c of failRefundCases) {
    it(c.title, async () => {
      const treasuryBalance = await provider.connection.getBalance(treasury);

      const [userBidPda, _nonce] = await PublicKey.findProgramAddress(
        [Buffer.from("user-bid"), c.account.publicKey.toBytes(), state.toBytes()],
        program.programId
      );

      try {
        await program.methods
          .refund()
          .accounts({
            state: state,
            treasury: treasury,
            user: c.account.publicKey,
            userBid: userBidPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([c.account])
          .rpc();
        throw new Error("Should have failed!");
      } catch (error) {
        expect(error.error.errorCode.code).equal(c.errorCode);
      }

      const updatedTreasuryBalance = await provider.connection.getBalance(treasury)
      expect(updatedTreasuryBalance).equal(treasuryBalance);
    });
  }

});


const fundAccount = async (provider: anchor.Provider, accountPubkey: anchor.web3.PublicKey, amount: number = 10000000000): Promise<void> => {
  const tx = await provider.connection.requestAirdrop(accountPubkey, amount);
  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({
    blockhash,
    lastValidBlockHeight,
    signature: tx
  });
}

const delay = ms => new Promise(res => setTimeout(res, ms));