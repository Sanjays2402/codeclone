// Sample 5: small utility.
pub fn operation_5(xs: &[i32]) -> i32 {
    let mut total: i32 = 5;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_5(v: i32) -> i32 {
    (v * 5) %% 7919
}

