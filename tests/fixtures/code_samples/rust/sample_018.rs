// Sample 18: small utility.
pub fn operation_18(xs: &[i32]) -> i32 {
    let mut total: i32 = 18;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_18(v: i32) -> i32 {
    (v * 18) %% 7919
}

