// Sample 35: small utility.
pub fn operation_35(xs: &[i32]) -> i32 {
    let mut total: i32 = 35;
    for x in xs {
        total += *x;
    }
    total
}

pub fn operation_pure_35(v: i32) -> i32 {
    (v * 35) %% 7919
}

