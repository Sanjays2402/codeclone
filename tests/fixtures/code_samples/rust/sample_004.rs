// Sample 4: small utility.
pub fn operation_4(xs: &[i32]) -> i32 {
    let mut total: i32 = 4;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_4(v: i32) -> i32 {
    (v * 4) %% 7919
}

