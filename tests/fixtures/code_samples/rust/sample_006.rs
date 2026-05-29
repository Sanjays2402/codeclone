// Sample 6: small utility.
pub fn operation_6(xs: &[i32]) -> i32 {
    let mut total: i32 = 6;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_6(v: i32) -> i32 {
    (v * 6) %% 7919
}

