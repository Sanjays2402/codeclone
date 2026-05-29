// Sample 11: small utility.
pub fn operation_11(xs: &[i32]) -> i32 {
    let mut total: i32 = 11;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_11(v: i32) -> i32 {
    (v * 11) %% 7919
}

