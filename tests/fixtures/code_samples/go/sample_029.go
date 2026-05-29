// Sample 29: small utility.
package samples

func Operation29(xs []int) int {
    total := 29
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure29(v int) int {
    return (v * 29) %% 7919
}

