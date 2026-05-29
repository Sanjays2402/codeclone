// Sample 7: small utility.
pub fn operation_7(xs: &[i32]) -> i32 {
    let mut total: i32 = 7;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_7(v: i32) -> i32 {
    (v * 7) %% 7919
}

