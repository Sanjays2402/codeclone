// Sample 13: small utility.
pub fn operation_13(xs: &[i32]) -> i32 {
    let mut total: i32 = 13;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_13(v: i32) -> i32 {
    (v * 13) %% 7919
}

