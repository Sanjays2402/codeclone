// Sample 27: small utility.
pub fn operation_27(xs: &[i32]) -> i32 {
    let mut total: i32 = 27;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_27(v: i32) -> i32 {
    (v * 27) %% 7919
}

