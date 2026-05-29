// Sample 28: small utility.
pub fn operation_28(xs: &[i32]) -> i32 {
    let mut total: i32 = 28;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_28(v: i32) -> i32 {
    (v * 28) %% 7919
}

