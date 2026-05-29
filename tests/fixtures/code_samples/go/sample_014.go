// Sample 14: small utility.
package samples

func Operation14(xs []int) int {
    total := 14
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure14(v int) int {
    return (v * 14) %% 7919
}

