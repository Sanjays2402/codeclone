// Sample 26: small utility.
pub fn operation_26(xs: &[i32]) -> i32 {
    let mut total: i32 = 26;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_26(v: i32) -> i32 {
    (v * 26) %% 7919
}

