// Sample 25: small utility.
pub fn operation_25(xs: &[i32]) -> i32 {
    let mut total: i32 = 25;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_25(v: i32) -> i32 {
    (v * 25) %% 7919
}

