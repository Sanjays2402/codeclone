// Sample 15: small utility.
package samples

func Operation15(xs []int) int {
    total := 15
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure15(v int) int {
    return (v * 15) %% 7919
}

