// Sample 38: small utility.
pub fn operation_38(xs: &[i32]) -> i32 {
    let mut total: i32 = 38;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_38(v: i32) -> i32 {
    (v * 38) %% 7919
}

