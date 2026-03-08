// SPDX-License-Identifier: MIT
// ZionDefi Protocol v2.0 — Pure Utility Helpers
// Standalone functions that do not depend on contract state.
use starknet::{ContractAddress, get_contract_address, SyscallResultTrait};
use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use core::num::traits::Zero;

// ============================================================================
// CALENDAR HELPERS  (used for calendar-monthly recurring billing)
// ============================================================================

/// Returns `true` when `year` is a Gregorian leap year.
pub fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0) && (year % 100 != 0 || year % 400 == 0)
}

/// Number of days in `month` of `year`, leap-year aware.
pub fn days_in_month(year: u64, month: u64) -> u64 {
    if month == 1 || month == 3 || month == 5 || month == 7
        || month == 8 || month == 10 || month == 12 {
        31
    } else if month == 4 || month == 6 || month == 9 || month == 11 {
        30
    } else {
        // February
        if is_leap_year(year) { 29 } else { 28 }
    }
}

/// Unix-epoch day number → (year, month, day).  Howard Hinnant algorithm.
pub fn civil_from_days(z: u64) -> (u64, u64, u64) {
    let z_adj: u64 = z + 719_468;
    let era: u64 = z_adj / 146_097;
    let doe: u64 = z_adj - era * 146_097;
    let yoe: u64 = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y: u64 = yoe + era * 400;
    let doy: u64 = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp: u64 = (5 * doy + 2) / 153;
    let d: u64 = doy - (153 * mp + 2) / 5 + 1;
    let m: u64 = if mp < 10 { mp + 3 } else { mp - 9 };
    let y_final: u64 = if m <= 2 { y + 1 } else { y };
    (y_final, m, d)
}

/// (year, month, day) → Unix-epoch day number.
pub fn days_from_civil(y_in: u64, m: u64, d: u64) -> u64 {
    let y: u64 = if m <= 2 { y_in - 1 } else { y_in };
    let era: u64 = y / 400;
    let yoe: u64 = y - era * 400;
    let mp: u64 = if m > 2 { m - 3 } else { m + 9 };
    let doy: u64 = (153 * mp + 2) / 5 + d - 1;
    let doe: u64 = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Returns the Unix timestamp for the same `billing_day` of the next calendar
/// month after `current_ts`.  Clamps `billing_day` to the actual length of that
/// month, so e.g. Jan 31 → Feb 28 (or Feb 29 in a leap year), not Mar 2.
pub fn next_monthly_timestamp(current_ts: u64, billing_day: u64) -> u64 {
    let seconds_per_day: u64 = 86_400;
    let current_day_number = current_ts / seconds_per_day;
    let (year, month, _) = civil_from_days(current_day_number);

    // Advance one calendar month.
    let (next_year, next_month): (u64, u64) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };

    // Clamp billing_day to valid range for next month (handles short months + leap Feb).
    let max_day = days_in_month(next_year, next_month);
    let actual_day = if billing_day > max_day { max_day } else { billing_day };

    days_from_civil(next_year, next_month, actual_day) * seconds_per_day
}

// ============================================================================
// SWAP LOGIC
// ============================================================================
#[inline(never)]
pub fn do_swap(
    avnu_router: ContractAddress,
    sell_token: ContractAddress,
    buy_token: ContractAddress,
    sell_amount: u256,
    expected_buy: u256,
    min_buy: u256,
    integrator_fees_bps: u128,
    routes: Span<felt252>,
) -> u256 {
    let card = get_contract_address();
    let sell_d = IERC20Dispatcher { contract_address: sell_token };
    
    sell_d.approve(avnu_router, 0);
    assert(sell_d.approve(avnu_router, sell_amount), 'Approve failed');

    let buy_d = IERC20Dispatcher { contract_address: buy_token };
    let pre = buy_d.balance_of(card);

    let mut calldata: Array<felt252> = array![];
    Serde::serialize(@sell_token, ref calldata);
    Serde::serialize(@sell_amount, ref calldata);
    Serde::serialize(@buy_token, ref calldata);
    Serde::serialize(@expected_buy, ref calldata);
    Serde::serialize(@min_buy, ref calldata);
    Serde::serialize(@card, ref calldata);
    Serde::serialize(@integrator_fees_bps, ref calldata);
    let zero_addr: ContractAddress = Zero::zero();
    Serde::serialize(@zero_addr, ref calldata);
    
    let mut i: u32 = 0;
    while i < routes.len() {
        calldata.append(*routes[i]);
        i += 1;
    };

    let mut ret = starknet::syscalls::call_contract_syscall(
        avnu_router, selector!("multi_route_swap"), calldata.span(),
    ).unwrap_syscall();
    
    let success: bool = Serde::deserialize(ref ret).unwrap();
    assert(success, 'Swap failed');

    let post = buy_d.balance_of(card);
    let credited = post - pre;
    assert(credited > 0, 'Swap returned nothing');
    credited
}
