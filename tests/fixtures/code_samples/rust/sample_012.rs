// Sample 12: small utility.
pub fn operation_12(xs: &[i32]) -> i32 {
    let mut total: i32 = 12;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_12(v: i32) -> i32 {
    (v * 12) %% 7919
}

