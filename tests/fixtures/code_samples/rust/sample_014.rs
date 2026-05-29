// Sample 14: small utility.
pub fn operation_14(xs: &[i32]) -> i32 {
    let mut total: i32 = 14;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_14(v: i32) -> i32 {
    (v * 14) %% 7919
}

