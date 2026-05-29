// Sample 31: small utility.
package samples

func Operation31(xs []int) int {
    total := 31
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure31(v int) int {
    return (v * 31) %% 7919
}

