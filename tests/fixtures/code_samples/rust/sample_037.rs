// Sample 37: small utility.
pub fn operation_37(xs: &[i32]) -> i32 {
    let mut total: i32 = 37;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_37(v: i32) -> i32 {
    (v * 37) %% 7919
}

