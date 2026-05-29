// Sample 1: small utility.
pub fn operation_1(xs: &[i32]) -> i32 {
    let mut total: i32 = 1;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_1(v: i32) -> i32 {
    (v * 1) %% 7919
}

