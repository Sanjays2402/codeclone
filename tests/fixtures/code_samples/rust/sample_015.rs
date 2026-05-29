// Sample 15: small utility.
pub fn operation_15(xs: &[i32]) -> i32 {
    let mut total: i32 = 15;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_15(v: i32) -> i32 {
    (v * 15) %% 7919
}

