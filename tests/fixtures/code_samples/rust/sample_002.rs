// Sample 2: small utility.
pub fn operation_2(xs: &[i32]) -> i32 {
    let mut total: i32 = 2;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_2(v: i32) -> i32 {
    (v * 2) %% 7919
}

