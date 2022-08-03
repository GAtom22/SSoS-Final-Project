use anchor_lang::{
    prelude::*,
    solana_program::{native_token::sol_to_lamports, program::invoke, system_instruction},
};

mod errors;
use crate::errors::AuctionError;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod auction {
    use anchor_lang::AccountsClose;

    use super::*;
    /// Creates and initialize a new state of our program
    pub fn initialize(
        ctx: Context<Initialize>,
        auction_duration: i64, /* optional parameters */
    ) -> Result<()> {
        // Get the clock sysvar via syscall
        let clock = Clock::get()?;
        let state = &mut ctx.accounts.state;

        state.bump = *ctx.bumps.get("state").unwrap();
        state.deadline = clock.unix_timestamp + auction_duration;
        state.initializer = ctx.accounts.initializer.key().clone();

        Ok(())
    }
    /// Bid
    pub fn bid(ctx: Context<PlaceBid>, amount: f64) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;

        if clock.unix_timestamp >= state.deadline {
            return err!(AuctionError::Finished);
        }

        let amount_in_lamports = sol_to_lamports(amount);

        // register user bid in PDA
        let user_bid = &mut ctx.accounts.user_bid;
        user_bid.amount = amount_in_lamports;

        // send funds to treasury account
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.user.key(),
                &ctx.accounts.treasury.key(),
                amount_in_lamports,
            ),
            &[
                ctx.accounts.user.to_account_info().clone(),
                ctx.accounts.treasury.clone(),
            ],
        )?;

        // check if highest bid
        if amount_in_lamports > state.highest_bid_amount {
            state.highest_bid_amount = amount_in_lamports;
            state.highest_bidder_account = ctx.accounts.user.key();
            state.highest_bidder_bump = *ctx.bumps.get("user_bid").unwrap();
        }

        Ok(())
    }
    /// After an auction ends (determined by `auction_duration`), a seller can claim the
    /// heighest bid by calling this instruction
    pub fn end_auction(ctx: Context<EndAuction>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;

        if clock.unix_timestamp < state.deadline {
            return err!(AuctionError::StillActive);
        }

        if state.seller_payed {
            return err!(AuctionError::AlreadyClaimedPrize);
        }
        // get highest bid and send to seller
        let amount_to_pay = ctx.accounts.user_bid.amount;

        // transfer amount from treasury account to initializer account
        if amount_to_pay > 0 {
            transfer_from_treasury(
                &ctx.accounts.treasury,
                &ctx.accounts.initializer.to_account_info(),
                amount_to_pay,
            )?;
        }

        state.seller_payed = true;
        state.highest_bid_amount = 0;

        Ok(())
    }
    /// After an auction ends (the initializer/seller already received the winning bid),
    /// the unsuccessfull bidders can claim their money back by calling this instruction
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;

        if clock.unix_timestamp < state.deadline {
            return err!(AuctionError::StillActive);
        }
        if !state.seller_payed {
            return err!(AuctionError::UnclaimedPrize);
        }

        // The highest bidder will get refunded only the rent payed for the user_bid PDA
        if state.highest_bidder_account != ctx.accounts.user.key() {
            let amount_to_refund = ctx.accounts.user_bid.amount;

            // transfer amount from treasury account to initializer account
            if amount_to_refund > 0 {
                transfer_from_treasury(
                    &ctx.accounts.treasury,
                    &ctx.accounts.user.to_account_info(),
                    amount_to_refund,
                )?;
            }
        }

        ctx.accounts.user_bid.close(ctx.accounts.user.to_account_info())?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// State of our auction program (up to you)
    #[account(
        init,
        payer = initializer,
        space = 8 + std::mem::size_of::<State>(),
        seeds = [b"state", initializer.key().as_ref()],
        bump
    )]
    pub state: Account<'info, State>,
    /// Seller
    #[account(mut)]
    pub initializer: Signer<'info>,
    /// Account which holds tokens bidded by biders
    /// CHECK:
    #[account(
        init,
        payer = initializer,
        space = 8, seeds = [b"treasury", state.key().as_ref()],
        bump
    )]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct State {
    deadline: i64,
    initializer: Pubkey,
    seller_payed: bool,
    highest_bid_amount: u64,
    highest_bidder_account: Pubkey,
    highest_bidder_bump: u8,
    bump: u8,
}

#[derive(Accounts)]
pub struct PlaceBid<'info> {
    /// State of our auction program (up to you)
    #[account(mut, seeds = [b"state", state.initializer.as_ref()], bump = state.bump)]
    pub state: Account<'info, State>,
    /// Account which holds tokens bidded by biders
    /// Bidder
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"treasury", state.key().as_ref()], bump)]
    /// CHECK:
    pub treasury: AccountInfo<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + std::mem::size_of::<UserBid>(),
        seeds = [b"user-bid", user.key().as_ref(), state.key().as_ref()],
        bump,
    )]
    pub user_bid: Account<'info, UserBid>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct UserBid {
    amount: u64,
}

// validation struct
#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(seeds = [b"state", state.initializer.as_ref()], bump = state.bump)]
    pub state: Account<'info, State>,
    #[account(mut, seeds = [b"treasury", state.key().as_ref()], bump)]
    /// CHECK:
    pub treasury: AccountInfo<'info>,
    #[account(mut)]
    /// CHECK:
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"user-bid", user.key().as_ref(), state.key().as_ref()], bump)]
    pub user_bid: Account<'info, UserBid>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EndAuction<'info> {
    #[account(mut, has_one = initializer, seeds = [b"state", state.initializer.as_ref()], bump = state.bump)]
    pub state: Account<'info, State>,
    /// Seller
    #[account(mut)]
    /// CHECK:
    pub initializer: Signer<'info>,
    /// Account which holds tokens bidded by biders
    #[account(mut, seeds = [b"treasury", state.key().as_ref()], bump)]
    /// CHECK:
    pub treasury: AccountInfo<'info>,
    #[account(seeds = [b"user-bid", &state.highest_bidder_account.to_bytes(), state.key().as_ref()], bump = state.highest_bidder_bump)]
    pub user_bid: Account<'info, UserBid>,
    pub system_program: Program<'info, System>,
}

//
/// A small utility function that allows us to transfer funds out of the Treasury.
///
/// # Arguments
///
/// * `treasury` - The escrow Token account
/// * `destination_wallet` - The public key of the destination address (where to send funds)
/// * `amount` - the amount of lamport that is sent from `treasury` to `user_receiving`
///
fn transfer_from_treasury<'info>(
    treasury: &AccountInfo,
    destination_wallet: &AccountInfo,
    amount: u64,
) -> Result<()> {
    if **treasury.try_borrow_lamports()? < amount {
        return err!(AuctionError::TreasuryInsufficientFunds);
    }

    **treasury.try_borrow_mut_lamports()? -= amount;
    **destination_wallet.try_borrow_mut_lamports()? += amount;

    Ok(())
}
