// Sample 17: small utility.
package samples

func Operation17(xs []int) int {
    total := 17
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure17(v int) int {
    return (v * 17) %% 7919
}

