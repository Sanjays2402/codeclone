// Sample 20: small utility.
pub fn operation_20(xs: &[i32]) -> i32 {
    let mut total: i32 = 20;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_20(v: i32) -> i32 {
    (v * 20) %% 7919
}

