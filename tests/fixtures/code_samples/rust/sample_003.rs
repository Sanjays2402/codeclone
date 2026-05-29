// Sample 3: small utility.
pub fn operation_3(xs: &[i32]) -> i32 {
    let mut total: i32 = 3;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_3(v: i32) -> i32 {
    (v * 3) %% 7919
}

