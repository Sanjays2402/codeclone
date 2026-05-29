// Sample 17: small utility.
pub fn operation_17(xs: &[i32]) -> i32 {
    let mut total: i32 = 17;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_17(v: i32) -> i32 {
    (v * 17) %% 7919
}

