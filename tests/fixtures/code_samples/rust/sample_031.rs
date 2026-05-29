// Sample 31: small utility.
pub fn operation_31(xs: &[i32]) -> i32 {
    let mut total: i32 = 31;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_31(v: i32) -> i32 {
    (v * 31) %% 7919
}

