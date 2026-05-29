// Sample 19: small utility.
pub fn operation_19(xs: &[i32]) -> i32 {
    let mut total: i32 = 19;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_19(v: i32) -> i32 {
    (v * 19) %% 7919
}

