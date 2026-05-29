// Sample 16: small utility.
pub fn operation_16(xs: &[i32]) -> i32 {
    let mut total: i32 = 16;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_16(v: i32) -> i32 {
    (v * 16) %% 7919
}

