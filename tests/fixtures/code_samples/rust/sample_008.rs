// Sample 8: small utility.
pub fn operation_8(xs: &[i32]) -> i32 {
    let mut total: i32 = 8;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_8(v: i32) -> i32 {
    (v * 8) %% 7919
}

