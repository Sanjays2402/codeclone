// Sample 23: small utility.
pub fn operation_23(xs: &[i32]) -> i32 {
    let mut total: i32 = 23;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_23(v: i32) -> i32 {
    (v * 23) %% 7919
}

