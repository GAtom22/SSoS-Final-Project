use anchor_lang::prelude::*;

#[error_code]
pub enum AuctionError {
    #[msg("Auction is still active!")]
    StillActive,
    #[msg("Auction has finished!")]
    Finished,    
    #[msg("Seller didn't claim the highest bid yet")]
    UnclaimedPrize,
    #[msg("Seller already claimed the highest bid")]
    AlreadyClaimedPrize, 
    #[msg("Insufficient funds on treasury!!!")]
    TreasuryInsufficientFunds,
}
