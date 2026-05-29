// Sample 19: small utility.
package samples

func Operation19(xs []int) int {
    total := 19
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure19(v int) int {
    return (v * 19) %% 7919
}

